import asyncio
import websockets
import json
import time

from transformers import TopPLogitsWarper, AutoModelForCausalLM, AutoTokenizer, TextStreamer, LogitsProcessorList, RepetitionPenaltyLogitsProcessor, LogitsWarper, TemperatureLogitsWarper
import torch
import argparse
import struct


parser = argparse.ArgumentParser()
parser.add_argument("--model", type=str, default="./openbuddy-13b-v1.3-fp16")
parser.add_argument("--server", type=str, default="127.0.0.1:8120")
parser.add_argument("--name", type=str, default="beagle")
parser.add_argument("--token", type=str, default="unsafe-default-token")
parser.add_argument("--max_concurrency", type=int, default=1)
parser.add_argument("--model-name", type=str, default="")
args = parser.parse_args()

MAX_TOKENS = 2048
HALF_MAX_TOKENS = MAX_TOKENS // 2


device = 'cuda'
dtype = torch.float16
modelPath = args.model
while modelPath.endswith("/") or modelPath.endswith("\\"):
    modelPath = modelPath[:-1]
if args.model.endswith("-bf16"):
    dtype = torch.bfloat16
modelName = modelPath.split("/")[-1].split("\\")[-1].lower()
print("Using device:", device, "dtype:", dtype)
model = AutoModelForCausalLM.from_pretrained(modelPath, torch_dtype=dtype)
tokenizer = AutoTokenizer.from_pretrained(modelPath)

print("Model loaded, model name:", modelName)

import deepspeed
dsConfig = {
    "tensor_parallel": { "tp_size": 1 },
}
# if it is llama, we need to patch the model with injection policy
if isinstance(model, LlamaForCausalLM):
    dsConfig['injection_policy'] = {LlamaDecoderLayer: ('self_attn.o_proj', 'mlp.up_proj')}


model = deepspeed.init_inference(model, **dsConfig)

url = "ws://%s/ws?name=%s&model=%s&token=%s&max_concurrency=%d" % (
    args.server, args.name, modelName, args.token, args.max_concurrency)

ws = None
msgQueue = []


cfg_topPWarper = TopPLogitsWarper(0.9)
cfg_temperature = 0.3
tasks = []
isTasksDirty = True
taskInputIds = None
taskAttnMasks = None
taskPosIds = None
taskPastKVs = None



class MyStreamer(TextStreamer):
    def __init__(self, id, **kwargs):
        super().__init__(**kwargs)
        # Pack big-endian uint32
        self.idbstr = struct.pack(">I", id)
        self.id = id

    def on_finalized_text(self, text: str, stream_end: bool = False):
        if not stream_end and len(text) == 0:
            return
        if len(text) > 0:
            msgQueue.append(self.idbstr + text.encode("utf-8"))
        if stream_end:
            print("Stream end, sending EOS:", self.id)
            msgQueue.append(self.idbstr)


async def tryConnectWS():
    global ws
    if ws is not None:
        try:
            await ws.close()
        except Exception as e:
            print("Error when closing ws", e)
    ws = None
    try:
        ws = await websockets.connect(url)
        print("Connect ws success.")
        return True
    except Exception as e:
        print("Connect ws failed", e)
    return False


async def trySendMsg(msg):
    global ws
    while True:
        if ws is None:
            print("Trying to reconnect...")
            await asyncio.sleep(10)
            await tryConnectWS()
        if ws is None:
            continue
        try:
            await ws.send(msg)
            return True
        except Exception as e:
            print("Error when sending message", e)
            ws = None


async def mainLoop():
    global ws, tasks
    asyncio.create_task(watchDog())
    lastPingTime = 0
    await tryConnectWS()
    while True:
        currentTime = time.time()
        if currentTime - lastPingTime > 10:
            lastPingTime = currentTime
            await trySendMsg("")
        if ws is None:
            await asyncio.sleep(1)
            continue

        msg = None
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=0.01)
        except Exception as e:
            # Check if it's timeout
            if type(e) != asyncio.TimeoutError:
                print("Error when receiving message", e)
                ws = None
                continue
        if msg is not None:
            handleMessage(msg)
        handleTasks()
        for msg in msgQueue:
            await trySendMsg(msg)
        msgQueue.clear()


def getTaskByID(id):
    global tasks
    for t in tasks:
        if t['id'] == id:
            return t
    return None

def addTask(t):
    global tasks, isTasksDirty
    if getTaskByID(t['id']) is not None:
        print("Task already exists, ignoring...")
        return
    isTasksDirty = True
    system_ids = tokenizer.encode(
        t['system'] + "\n\n", truncation=True, max_length=MAX_TOKENS)
    prompt = ''
    for m in t['messages']:
        role = "User"
        if m['role'].lower() == 'assistant':
            role = "Assistant"
        prompt += "%s: %s\n" % (role, m['content'])
        if role == "Assistant":
            prompt += "\n"
    prompt += "Assistant:"
    print(prompt)
    prompt_ids = tokenizer.encode(
        prompt, truncation=True, max_length=60000)
    prompt_max_len = MAX_TOKENS - 200 - len(system_ids)
    t['prompt_max_len'] = prompt_max_len
    if prompt_max_len < 0:
        print("System prompt too long, skipping...")
        return
    # Check if larger than HALF_MAX_TOKENS
    if prompt_max_len < len(prompt_ids):
        prompt_ids = prompt_ids[-prompt_max_len:]
    t['ids'] = system_ids + prompt_ids
    t['streamer'] = MyStreamer(t['id'], tokenizer=tokenizer)
    tasks.append(t)


def handleMessage(msg):
    global tasks, isTasksDirty
    print("Received message", msg)
    if len(msg) > 0:
        msg = json.loads(msg)
        if 'stop' in msg:
            newtasks = [t for t in tasks if t['id'] != msg['id']]
            if len(newtasks) != len(tasks):
                tasks = newtasks
                isTasksDirty = True
                print("Task stopped:", msg['id'])
            else:
                print("Task not found:", msg['id'])
        else:
            addTask(msg)



@torch.inference_mode()
def handleTasks():
    global tasks, isTasksDirty, taskInputIds, taskAttnMasks, taskPosIds, taskPastKVs
    if len(tasks) == 0:
        return
    print("Handling tasks:", len(tasks))

    for t in tasks:
        if len(t['ids']) > MAX_TOKENS - 50:
            t['ids'] = t['ids'][-HALF_MAX_TOKENS:]
            isTasksDirty = True

    if isTasksDirty:
        maxTLen = max([len(t['ids']) for t in tasks])
        taskInputIds = torch.tensor(
            [[model.config.pad_token_id] * (maxTLen - len(t['ids'])) + t['ids'] for t in tasks]).to(device)
        taskAttnMasks = torch.tensor(
            [[0] * (maxTLen - len(t['ids'])) + [1] * len(t['ids']) for t in tasks]).to(device)
        taskPosIds = taskAttnMasks.cumsum(-1) - 1
        taskPosIds.masked_fill_(taskAttnMasks == 0, 1)
        taskPastKVs = None
        isTasksDirty = False

    outputs = model(
        input_ids=taskInputIds,
        attention_mask=taskAttnMasks,
        past_key_values=taskPastKVs,
        position_ids=taskPosIds,
        use_cache=True,
        return_dict=True
    )
    next_token_logits = outputs.logits[:, -1, :]
    if cfg_temperature == 0:
        next_tokens = torch.argmax(next_token_logits, dim=-1)
    else:
        probs = torch.nn.functional.softmax(next_token_logits / cfg_temperature, dim=-1)
        probs = cfg_topPWarper(taskInputIds, probs)
        next_tokens = torch.multinomial(probs, num_samples=1).squeeze(1)

    taskInputIds = next_tokens.unsqueeze(-1)
    taskPosIds = taskPosIds[:, -1].unsqueeze(-1) + 1
    taskAttnMasks = torch.cat([taskAttnMasks, torch.ones(
        len(tasks), 1, dtype=torch.long, device=device)], dim=-1)
    taskPastKVs = outputs.past_key_values
    tasksToDelete = []
    next_tokens = next_tokens.cpu()
    for i, t in enumerate(tasks):
        next_token = next_tokens[i].item()
        streamer: MyStreamer = t['streamer']
        t['max_new_tokens'] -= 1
        if next_token != tokenizer.eos_token_id:
            streamer.put(next_tokens[i].unsqueeze(0))
            t['ids'].append(next_token)
        if (t['max_new_tokens'] <= 0) or (next_token == tokenizer.eos_token_id):
            print("Finishing task", t['id'])
            streamer.end()
            tasksToDelete.append(i)
            continue
    if len(tasksToDelete) > 0:
        tasks = [t for i, t in enumerate(tasks) if i not in tasksToDelete]
        isTasksDirty = True


# Called every 30 seconds
async def watchDog():
    while True:
        await asyncio.sleep(30)
        print("=== Info, time:", time.time())
        print("Tasks:", len(tasks))
        for t in tasks:
            print("Task", t['id'], ":", len(t['ids']), t['max_new_tokens'])
        print('======')


asyncio.run(mainLoop())

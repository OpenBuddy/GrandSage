import asyncio
import websockets
import json
import time
import torch
import argparse
import struct
import os
import vllm

from vllm import EngineArgs, LLMEngine, SamplingParams, RequestOutput




parser = argparse.ArgumentParser()
parser.add_argument("--server", type=str, default="127.0.0.1:8120")
parser.add_argument("--name", type=str, default="beagle")
parser.add_argument("--token", type=str, default="unsafe-default-token")
parser.add_argument("--max_concurrency", type=int, default=1)
parser.add_argument("--model_name", type=str, default="")
parser.add_argument("--model_max_tokens", type=int, default=2048)
parser = EngineArgs.add_cli_args(parser)
args = parser.parse_args()

modelName = args.model_name
if modelName == "":
    modelName = args.model.split("/")[-1].split("\\")[-1]
print("Model name: ", modelName)
MODEL_MAX_TOKENS = args.model_max_tokens


engine_args = EngineArgs.from_cli_args(args)
engine: LLMEngine = LLMEngine.from_engine_args(engine_args)
tokenizer = engine.tokenizer # AutoTokenizer.from_pretrained(modelName)

url = "ws://%s/ws?name=%s&model=%s&token=%s&max_concurrency=%d" % (
    args.server, args.name, modelName, args.token, args.max_concurrency)


tasks = {}

def getTaskByID(id):
    global tasks
    if id in tasks:
        return tasks[id]

def addTask(t):
    global tasks, isTasksDirty
    if getTaskByID(t['id']) is not None:
        print("Task already exists, ignoring...")
        return
    isTasksDirty = True
    system_ids = tokenizer.encode(
        t['system'] + "\n\n", truncation=True, max_length=MODEL_MAX_TOKENS, add_special_tokens = False)
    prompt = ''
    for m in t['messages']:
        role = "User"
        if m['role'].lower() == 'assistant':
            role = "Assistant"
        prompt += "%s: %s\n" % (role, m['content'])
        if role == "Assistant":
            prompt += "\n"
    prompt += "Assistant:"
    prompt_ids = tokenizer.encode(
        prompt, truncation=True, max_length=60000, add_special_tokens = False)
    prompt_max_len = MODEL_MAX_TOKENS - 50 - t['max_new_tokens'] - len(system_ids)
    t['prompt_max_len'] = prompt_max_len
    if prompt_max_len < 0:
        print("System prompt too long, skipping...")
        return
    # Check if larger than HALF_MAX_TOKENS
    if prompt_max_len < len(prompt_ids):
        prompt_ids = prompt_ids[-prompt_max_len:]
    t['tokens_generated'] = 0
    t['start_time'] = time.time()
    t['last_output_str'] = ''
    t['idbstr'] = struct.pack(">I", t['id'])
    tasks[t['id']] = t
    prompt_str = tokenizer.decode(system_ids + prompt_ids)
    print(prompt_str)
    engine.add_request(str(t['id']), prompt_str, SamplingParams(
        max_tokens=t['max_new_tokens'], temperature=t['temperature']))


ws = None

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

def handleMessage(msg):
    global tasks, isTasksDirty
    print("Received message", msg)
    if len(msg) > 0:
        msg = json.loads(msg)
        if 'stop' in msg:
            if msg['id'] in tasks:
                del tasks[msg['id']]
                engine.abort_request(str(msg['id']))
                print("Task stopped:", msg['id'])
            else:
                print("Task not found:", msg['id'])
        else:
            addTask(msg)

async def handleTasks():
    global tasks
    request_outputs = engine.step()
    for ro in request_outputs:
        rid = int(ro.request_id)
        if not rid in tasks:
            print("Wow, request id not found:", rid)
            engine.abort_request(ro.request_id)
            continue
        t = tasks[rid]
        outputStr = ro.outputs[0].text
        lastStr = t['last_output_str']
        if len(outputStr) > len(lastStr):
            if lastStr != outputStr[:len(lastStr)]:
                print("Warning: output string not match:", outputStr, lastStr)
            diff = outputStr[len(lastStr):]
            await trySendMsg(t['idbstr'] + diff.encode('utf-8'))
            t['last_output_str'] = outputStr
        if ro.finished:
            del tasks[rid]
            print("Task finished:", rid)
            await trySendMsg(t['idbstr'])
            continue
        
        
        


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
            waitTime = 0.001
            if len(tasks) == 0:
                waitTime = 0.1
            msg = await asyncio.wait_for(ws.recv(), timeout=waitTime)
        except Exception as e:
            # Check if it's timeout
            if type(e) != asyncio.TimeoutError:
                print("Error when receiving message", e)
                ws = None
                continue
        if msg is not None:
            handleMessage(msg)
        await handleTasks()



# Called every 30 seconds
async def watchDog():
    while True:
        await asyncio.sleep(30)
        print("=== Info, time:", time.time())
        print("Tasks:", len(tasks))
        for t in tasks.values():
            print("Task", t['id'], ":", t['tokens_generated'])
        print('======')


asyncio.run(mainLoop())

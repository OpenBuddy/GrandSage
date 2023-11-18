# Convert huggingface model to 16
from transformers import AutoModelForCausalLM, AutoConfig
import sys
import torch

if len(sys.argv) != 4 :
    print('Usage: python convert-to-16.py <model_path> <output_path> <dtype>')
    sys.exit(1)
dtype = sys.argv[3]
if dtype == 'bf16':
    torch_dtype = torch.bfloat16
elif dtype == 'fp16':
    torch_dtype = torch.float16
else:
    print('dtype must be bf16 or fp16')
    sys.exit(1)

cfg = AutoConfig.from_pretrained(sys.argv[1])
cfg.use_cache = True

model = AutoModelForCausalLM.from_pretrained(sys.argv[1],
                                             torch_dtype=torch_dtype, 
                                             trust_remote_code=True,
                                             config=cfg)

print('Model loaded.')

model.save_pretrained(sys.argv[2] + '-' + dtype, safe_serialization=False)


print('Done!')
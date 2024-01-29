#!/bin/bash
# export NCCL_P2P_DISABLE=1

python main.py \
    --token "unsafe-test-node-token" \
    --name "buddy" \
    --server "ws://127.0.0.1:8120/ws"  \
    --model "../../models/7bx8-v16.3-awq" \
    --tensor-parallel-size 2  \
	--max_concurrency 100 \
    --model_name "7bx8-v16.3-awq"  \
    --max-model-len 4096 \
    --trust-remote-code --enforce-eager

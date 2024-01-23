#!/bin/bash


python main.py \
    --token "unsafe-test-node-token" \
    --name "beagle" \
    --server "ws://127.0.0.1:8120/ws" \  
    --model "openbuddy-mixtral-7bx8-v16.3-32k" \ 
    --tensor-parallel-size 4  \
	--max_concurrency 400 \
    --model_name "7bx8-latest" \
    --max-model-len 4096 \
    --trust-remote-code

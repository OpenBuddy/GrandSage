# GrandSage

GrandSage（大贤者） is a distributed Large Language Model (LLM) inference framework that aims to support as many concurrent users as possible using reasonably priced cloud services. 

Please note that this project is still in the early stages of development.

## System Architecture

The system is currently divided into three parts: 1. Model API Server (and Broker), 2. vLLM Node, and 3. Llama.cpp Node.

1. The Model API Server is written in node.js. It handles user requests, selects and sends them to an inference node, and streams the responses from the inference node to the user.
2. The vLLM inference Node is written in Python and uses the `vllm` library to support fast inference on GPUs.
4. The API Server and node communicate via WebSocket, based on a dedicated protocol definition. Please refer to [docs/ws-protocol.md] for more details.

## Deployment

### Model API Server

1. Clone the repository.
2. Create `config.json` based on `config.template.json`:
```
{
    "nodeToken":"unsafe-default-token", # Token for vLLM nodes to connect to the server
    "users" : {
      "alice" : {
        "token" : "unsafe-test-token" # Token for this API user
      }
    }
  }
```
3. Install dependencies: `npm install`, run the server: `node server.js`, it will listen on port 8120 by default.

### vLLM Node

After installed [vLLM](https://github.com/vllm-project/vllm), you may use the following script to start a vLLM node:

```
#!/bin/bash
export CUDA_VISIBLE_DEVICES=0           # Assuming using GPU 0
python main.py \
    --token "unsafe-default-token" \    # nodeToken in config.json
    --name "adam" \                     # Name of this node
    --server "127.0.0.1:8120" \         # Address of the API server
    --model "../mymodel" \              # Path to the model directory
    --tensor-parallel-size 1  \         # Number of GPUs to use
    --model_name "7b-latest" \          # Name of the model
	--max_concurrency 250               # Max simultaneous requests for this node
```

### Using the playground

We have provided a simple web-based playground for testing the API Server. To use it, you need a web server that can serve static files. For example, you can use `cd playground; python3 -m http.server` to start a simple HTTP server.

Then, open `localhost:8000` in your browser, and you can start chatting with the AI.

## Disclaimer

The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.

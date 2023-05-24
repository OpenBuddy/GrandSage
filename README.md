# GrandSage

GrandSage（大贤者） is a distributed Large Language Model (LLM) inference framework that aims to support as many concurrent users as possible using reasonably priced cloud services. Please note that this project is still in the early stages of development and is currently not functional.

## TO-DO List
- Implement GPU inference nodes using the transformers library
- Implement CPU inference and small VRAM GPU inference nodes using the llama.cpp library
- Implement concurrent inference support for nodes (i.e., a node can accept new tasks and execute them concurrently while processing a request)
- Implement task scheduling, capable of managing multiple nodes and dynamically allocating tasks according to each node's concurrency capacity
- Implement KV-Cache retention technique, where nodes keep the previous KV-Cache for a period of time, allowing the retention of KV-Cache when processing user's continued dialogue requests without having to process the user's entire chat context from scratch
- A simple and understandable API that supports streaming inference results to the terminal

## System Architecture

The system is currently divided into three parts: 1. Broker, 2. Python Node, and 3. Llama.cpp Node.

1. The broker is written in node.js. It handles user requests, selects and sends them to an inference node, and streams the responses from the inference node.
2. The Python Node is written in Python and uses the transformers library to support as many models as possible.
3. Based on a highly optimized C++ library, the Llama.cpp Node is dedicated to implementing slower, less accurate inference capabilities on low-cost hardware.
4. The broker and node communicate via WebSocket, based on a dedicated protocol definition. Please refer to docs/ws-protocol.md for more details.

## Disclaimer

The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.

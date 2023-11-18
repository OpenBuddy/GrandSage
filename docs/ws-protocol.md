# WebSocket Protocol Documentation between API Server and Node

## WebSocket Connection

The WebSocket connection is established by the Node connecting to the API Server. The connection URL includes several parameters:

- `token`: A string that authenticates the Node.
- `model`: The name of the model that the Node will be running.
- `max_concurrency`: The maximum number of concurrent tasks that the Node can handle.
- `name`: The name of the Node.

Example URL: `ws://api-server-url?token=token_value&model=model_name&max_concurrency=max_concurrency_value&name=node_name`

## Data Exchange

Data is exchanged between the API Server and the Node in two formats: Text and Binary.

### Text Data

The API Server sends tasks to the Node in the form of Text data. This data is a JSON string that represents a task. The task object includes several properties:

- `state`: The current state of the task.
- `id`: The unique identifier of the task.
- `system`: The system message for the task.
- `messages`: The messages related to the task.
- `max_new_tokens`: The maximum number of new tokens for the task.
- `temperature`: The temperature setting for the task.
- `created_at`: The timestamp when the task was created.

Example JSON string: `{"state": 0, "id": 123, "system": "system_message", "messages": ["message1", "message2"], "max_new_tokens": 100, "temperature": 0.5, "created_at": 1633028302}`

### Binary Data

The Node sends results back to the API Server in the form of Binary data. The first four bytes of the Binary data are an Int32BE that represents the task ID. 

If there is additional data following the task ID, this indicates that the task has more generated text. The additional data is a UTF-8 string that represents the generated text.

If there is no additional data following the task ID, this indicates that the task has finished.

## Error Handling

If the Node receives a task that it cannot process (for example, the task is not in a pending state or the Node is not connected), it will log a warning and not process the task.

If the Node receives data for an unknown task or a task that is not running, it will remove the task and log a warning.

If the Node encounters an error while processing a task, it will disconnect the WebSocket connection and log the error.
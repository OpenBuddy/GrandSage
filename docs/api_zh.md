# `/api/chat` API文档

本API采用HTTP POST方法进行请求，并需要设置Authorization header为token。

## 请求格式

请求格式如下：

```
POST /api/chat HTTP/1.1
Authorization: Bearer YOUR_TOKEN

{
  "model": "openbuddy-13b-v1.3-fp16",
  "messages": [
    {
      "role": "user",
      "content": "test"
    }
  ],
  "temperature": 0.5,
  "max_new_tokens": 700,
  "conversation_id": genUUID4(),
  "user_id": getUserID()
}
```

## 请求参数

请求参数包含以下字段：

- `model`: 选择的模型名称，例如："openbuddy-13b-v1.3-fp16"。
- `messages`: 会话消息数组，每个元素是一个对象，包含角色（"user"或"AI"）和内容。
- `temperature`: 控制AI生成结果的随机性的值，范围在0和0.9之间，值越大结果越随机。
- `max_new_tokens`: AI在每个响应中最多生成的新token数。
- `conversation_id`: 对话UUID，由客户端生成。
- `user_id`: 用户ID，用于审查。

## 响应格式

响应是流式传输的JSON lines，每一行用"\n"分隔，都是一个JSON对象。例如：

```
{"o":"Hello! How can I "}
{"o":"help you today?\n"}
{"done":true}
```

响应对象可能包含以下字段：

- `o`: 文本片段
- `done`: 表示生成已完成
- `err`: 错误信息

## 数据处理

由于TCP传输过程中数据可能会分开、合并传输，不能假定每次传输的数据是一行或者是一个完整的UTF8字符串。因此，客户端需要将数据缓存到buffer里，并不断从buffer里查找"\n"字节，找出并处理完整的行。

## 错误处理

`err`字段可能会在生成开始时或者生成过程中产生。如果在生成任何文本之前就发生错误，那么就应该按照错误处理。如果生成了一部分文本后发生了错误，那么可以保留已生成的部分，并和正常完成的请求一样处理，保存至会话记录并为下一次交互做准备。

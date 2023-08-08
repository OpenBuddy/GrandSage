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
  "conversation_id": getConversationID(),
  "user_id": getUserID()
}
```

## 请求参数

请求参数包含以下字段：

- `model`: 选择的模型名称，例如："openbuddy-13b-v1.3-fp16"。
- `messages`: 会话消息数组，每个元素是一个对象，包含角色（role，可以是"user"或"assistant"）和内容（content）。
- `temperature`: 控制AI生成结果的随机性的值，范围在0和0.9之间，值越大结果越具备随机性、越有创意。
- `max_new_tokens`: AI在每个响应中最多生成的新token数。
- `conversation_id`: 对话ID，由客户端生成。必须是UUID的格式。
- `user_id`: 应用的用户ID，用于审查。

在标准的问答场景中，messages数组的最后一项的role应当以user，此时，模型会以assistant的身份输出新消息回答用户。

在需要续写assistant的回答的场景时，最后一项的role应当为assistant，之后模型会在之前的回答的基础上续写，并只输出续写后的部分。


## 响应格式

服务器返回的是流式传输的JSON lines，每一行用"\n"分隔，都是一个JSON对象。例如：

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

TCP传输过程中数据可能会分开、合并传输，不能假定每次传输的数据是一行或者是一个完整的UTF8字符串。因此，客户端需要将数据缓存到buffer里，并不断从buffer里查找"\n"字节，找出并处理完整的行。

## 错误处理

`err`字段可能会在生成开始时或者生成过程中产生。如果在生成任何文本之前就发生错误，那么就应该按照错误处理。如果生成了一部分文本后发生了错误，那么可以保留已生成的部分，并视为正常结果处理，保存至会话记录并为下一次交互做准备。

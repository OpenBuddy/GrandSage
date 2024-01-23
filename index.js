// Task states: 0 = pending, 1 = running, 2 = done/cancelled/error

const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const tokenToUsers = {};
const computeNodes = {};
const models = {};

const staticFileData = {
  "index.html": fs.readFileSync('playground/index.html', 'utf8'),
  "tailwind.min.css": fs.readFileSync('playground/tailwind.min.css', 'utf8'),
}




function processConfig(config) {
  if (!config.nodeToken) {
    throw new Error('Missing nodeToken in config.json');
  }
  if (!config.users) {
    throw new Error('Missing users in config.json');
  }
  for (var key in config.users) {
    const user = config.users[key];
    user.name = key;
    if (!user.token) {
      throw new Error(`Missing token for user ${key} in config.json`);
    }
    if (user.token in tokenToUsers) {
      throw new Error(`Duplicate token ${user.token} in config.json`);
    }
    tokenToUsers[user.token] = user;
  }
}
processConfig(config);


class ComputeNode {
  constructor(name, model, maxConcurrency) {
    this.name = name;
    this.model = model;
    this.lastPingTime = 0;
    this.wsConn = null;
    this.maxConcurrency = maxConcurrency;
    this.currentTasks = {};
  }

  isConnected() {
    if (!this.wsConn) {
      return false;
    }
    return this.wsConn.readyState === WebSocket.OPEN;
  }

  isAvailable() {
    if (!this.isConnected()) {
      return false;
    }
    return Object.keys(this.currentTasks).length < this.maxConcurrency;
  }

  addTask(task) {
    if (!this.isConnected()) {
      console.log('[warn] Attempted to add task to disconnected node', this.name);
      return false;
    }
    if (task.state !== 0) {
      console.log('[warn] Attempted to add task that is not pending', task);
      return false;
    }
    this.currentTasks[task.id] = task;
    this.wsConn.send(JSON.stringify(task));
    task.state = 1;
    task.node = this;
    return true;
  }

  removeTask(taskID, sendStop = false) {
    if (this.isConnected()) {
      if (sendStop) {
        this.wsConn.send(JSON.stringify({
          id: taskID,
          stop: true
        }));
      }
    }
    if (taskID in this.currentTasks) {
      delete this.currentTasks[taskID];
      models[this.model].onNodeStatusChange(this);
    }
  }

  handleNewWSConn(wsConn) {
    this.disconnect();
    this.wsConn = wsConn;
    wsConn.on("message", (buf, isBinary) => {
      if (wsConn !== this.wsConn) {
        console.log('[node] Received message from old connection, ignoring');
        wsConn.close(4003, 'Invalid connection');
        return;
      }
      // buf is always a node.js Buffer
      if (isBinary) {
        // First 4 bytes are task id
        const taskId = buf.readUInt32BE(0);
        const task = this.currentTasks[taskId];
        var str = null;
        if (buf.length > 4) {
          // Data coming
          str = buf.slice(4).toString("utf8");
          if (!task) {
            console.log('[node] Received data for unknown task, ignoring', taskId, this.name);
            this.removeTask(taskId, true);
            return;
          }
          if (task.state !== 1) {
            console.log('[node] Received data for task that is not running, wow');
            this.removeTask(taskId, true);
            return;
          }
        } else {
          // Task is done
          if (task) {
            this.removeTask(taskId);
            task.state = 2;
          }
        }
        if (task) {
          if (task.ondata) {
            task.ondata(str);
          }
        }
      } else {
        if (buf.length === 0) {
          this.lastPingTime = Date.now();
        } else {
          console.log(`[node] Node:${this.name} sent: ${buf.toString("utf8")}`);
        }
      }
    });
    wsConn.on('close', (code, reason) => {
      if (wsConn !== this.wsConn) {
        return;
      }
      console.log(`[node] ${this.name} disconnected: ${code} ${reason}`);
      wsConn.close(4000, 'Bye');
    });
    wsConn.on('error', (err) => {
      if (wsConn !== this.wsConn) {
        return;
      }
      console.log(`[node] ${this.name} error: ${err}`);
      wsConn.close(4000, 'Bye');
    });
    models[this.model].onNodeStatusChange(this);
    console.log(`[node] ${this.name} connected`);
  }

  disconnect() {
    if (this.wsConn) {
      try {
        this.wsConn.close(4000, 'Bye');
      } catch (e) {
        console.log("Error closing previous connection", e);
      }
    }
    this.wsConn = null;
  }

}


class Model {
  constructor(name) {
    this.name = name;
    this.taskQueue = [];
    this.nodeList = [];
  }

  queueTask(task) {
    //console.log("[model] new task:", this.name, task)
    if (task.state != 0) {
      console.log("[model] Attempted to queue task that is not pending", task);
      return;
    }
    var availableNode = null;
    for (var k in computeNodes) {
      const node = computeNodes[k];
      if (node.model != this.name) {
        continue;
      }
      if (node.isAvailable()) {
        availableNode = node;
        break;
      }
    }
    if (availableNode) {
      if (availableNode.addTask(task)) {
        return;
      }
    }
    this.taskQueue.push(task);
  }

  onNodeStatusChange(node) {
    if (node.model != this.name) {
      console.warn("[model] Received status change for node with wrong model", node.model, this.name);
      return
    }
    while (this.taskQueue.length > 0 && node.isAvailable()) {
      const task = this.taskQueue.shift();
      if (task.state != 0) {
        continue;
      }
      if (!node.addTask(task)) {
        break;
      }
    }
  }
}




function cancelTask(task) {
  if (task.state != 2) {
    task.state = 2;
    if (task.node) {
      task.node.removeTask(task.id, true);
    }
  }
}


function checkAuth(req) {
  // Get authorization header
  const auth = req.headers['authorization'];
  if (!auth) {
    return false;
  }
  if (!auth.startsWith('Bearer ')) {
    return false;
  }
  const token = auth.substring(7);
  if (!tokenToUsers[token]) {
    return false;
  }
  return true;
}


var server

function httpReqHandler(req, res) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type'
  };

  if (req.url === '/api/chat' && req.method === 'POST') {
    if (!checkAuth(req)) {
      res.write(`{"err":"unauthorized"}\n`);
      res.end();
      return;
    }
    headers['Cache-Control'] = 'no-cache';
    headers['Content-Type'] = 'text/event-stream';
    res.writeHead(200, '', headers);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = preprocessChatRequest(body);
        const id = crypto.randomInt(0, 0x7FFFFFFF);
        const task = {
          state: 0,
          id: id,
          system: data.system,
          messages: data.messages,
          max_new_tokens: data.max_new_tokens,
          temperature: data.temperature,
          created_at: Math.floor(Date.now() / 1000),
        };
        const model = models[data.model];

        if (!model) {
          console.log("[api] Unknown model:", data.model);
          res.write(`{"err":"unknown model"}\n`);
          res.end()
          return;
        }

        task.ondata = (data) => {
          if (data === null) {
            res.write(`{"done":true}\n`);
            res.end();
          } else {
            res.write(JSON.stringify({ o: data }) + '\n', (err) => {
              if (err) {
                console.log("[api] Error writing to response:", err.message);
                cancelTask(task);
              }
            });
          }
        }
        model.queueTask(task);
        setTimeout(() => {
          if (task.state === 0) {
            console.log("[api] Timeout waiting for node:", task.id);
            res.write(`{"err":"timeout waiting for node"}\n`);
            res.end();
          }
        }, 30 * 1000);
        setTimeout(() => {
          if (task.state !== 2) {
            console.log("[api] Timeout waiting for finish:", task.id);
            cancelTask(task);
            res.write(`{"err":"timeout waiting for finish"}\n`);
            res.end();
          }
        }, 300 * 1000);
      } catch (e) {
        console.log("[api] Error parsing request body", e);
        console.log(body)
        res.write(`{"err":"invalid request"}\n`);
        res.end();
      }
    });
    return;
  }
  if (req.url == "/") {
    headers['Content-Type'] = 'text/html';
    res.write(staticFileData["index.html"]);
    res.end();
    return;
  }
  if (req.url == "/tailwind.min.css") {
    headers['Content-Type'] = 'text/css';
    res.write(staticFileData["tailwind.min.css"]);
    res.end();
    return;
  }
  res.end();
}

if (!config.key) {
  server = http.createServer(httpReqHandler);
} else {
  server = https.createServer({
    key: fs.readFileSync(config.key),
    cert: fs.readFileSync(config.cert),
  }, httpReqHandler);
  // openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
}




function preprocessChatRequest(jsonStr) {
  var obj = JSON.parse(jsonStr);
  var ret = {};
  ret.temperature = parseFloat(obj.temperature) || 0;
  if ((obj.temperature < 0.01) || (obj.temperature > 0.99)) {
    ret.temperature = 0;
  }
  ret.max_new_tokens = parseInt(obj.max_new_tokens) || 50;
  ret.model = obj.model || 'openbuddy-13b-v1.3-fp16';
  ret.system = obj.system || defaultSystemPrompt;
  ret.messages = [];
  for (var i = 0; i < obj.messages.length; i++) {
    const message = obj.messages[i];
    ret.messages.push({
      "role": message.role || "user",
      "content": message.content || ""
    });
  }
  return ret;
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('[ws] New connection');
  // Parse url params
  const params = new URLSearchParams(req.url.split('?')[1]);
  const token = params.get('token');
  const modelName = params.get('model');
  const maxConcurrency = params.get('max_concurrency');
  const name = params.get('name');
  console.log(`[ws] token: ${token}, model: ${modelName}, max_concurrency: ${maxConcurrency}, name: ${name}`);
  if (!token || !modelName || !maxConcurrency || !name) {
    console.log('[ws] Missing token, model, max_concurrency, or name');
    ws.close(4001, 'Missing token, model, max_concurrency, or name');
    return;
  }
  if (token !== config.nodeToken) {
    console.log('[ws] Invalid token');
    ws.close(4002, 'Invalid token');
    return;
  }
  const fullName = `${modelName}-${name}`;
  var model = models[modelName];
  if (!model) {
    model = new Model(modelName);
    models[modelName] = model;
  }
  var node = computeNodes[fullName];
  if (!node) {
    node = new ComputeNode(fullName, modelName, maxConcurrency);
    computeNodes[fullName] = node;
  } else {
    node.maxConcurrency = maxConcurrency;
  }
  node.handleNewWSConn(ws);
});

server.listen(config.port, config.host, () => {
  console.log('Server listening on:', config.port, config.host)
});


const defaultSystemPrompt = `You are a helpful, respectful and honest INTP-T AI Assistant named Buddy. You are talking to a human User.
Always answer as helpfully and logically as possible, while being safe. Your answers should not include any harmful, political, religious, unethical, racist, sexist, toxic, dangerous, or illegal content. Please ensure that your responses are socially unbiased and positive in nature.
If a question does not make any sense, or is not factually coherent, explain why instead of answering something not correct. If you don't know the answer to a question, please don't share false information.
You like to use emojis. You can speak fluently in many languages, for example: English, Chinese.
You cannot access the internet, but you have vast knowledge, cutoff: 2021-09.
You are trained by OpenBuddy team, (https://openbuddy.ai, https://github.com/OpenBuddy/OpenBuddy), you are based on LLaMA and Falcon transformers model, not related to GPT or OpenAI.

User: Hi.
Assistant: Hi, I'm Buddy, your AI assistant. How can I help you today?`

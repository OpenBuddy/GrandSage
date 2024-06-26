// Task states: 0 = pending, 1 = running, 2 = done/cancelled/error

const TASK_STATE_PENDING = 0;
const TASK_STATE_RUNNING = 1;
const TASK_STATE_DONE = 2;

const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
var moderationList = []
var moderationRegex = null;

if (config.moderation_lst) {
  // Open lst file
  moderationList = fs.readFileSync(config.moderation_lst, 'utf8').split('\n');
  for (var i = 0; i < moderationList.length; i++) {
    moderationList[i] = moderationList[i].trim();
    if (moderationList[i].length == 0) {
      throw new Error('Empty line in moderation list');
    }
  }
  // ignore case for moderation list
  moderationRegex = new RegExp(moderationList.join('|'), 'i');
  console.log('[moderation] Loaded moderation regex:', moderationRegex);
}

function doModeration(text) {
  if (!moderationRegex) {
    return 0;
  }
  if (moderationRegex.test(text)) {
    return 1;
  }
}



const tokenToUsers = {};
const computeNodes = {};
const models = {};
var reqCounter = Date.now() % 0x70000000;

function allocReqID() {
  reqCounter += 1;
  reqCounter %= 0x70000000;
  return reqCounter;
}



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
    user.token = '-';
    user.name = key;
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
    if (task.state !== TASK_STATE_PENDING) {
      console.log('[warn] Attempted to add task that is not pending', task);
      return false;
    }
    this.currentTasks[task.id] = task;
    this.wsConn.send(JSON.stringify(task));
    task.state = TASK_STATE_RUNNING;
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
          if (task.state !== TASK_STATE_RUNNING) {
            console.log('[node] Received data for task that is not running, wow');
            this.removeTask(taskId, true);
            return;
          }
        } else {
          // Task is done
          if (task) {
            this.removeTask(taskId);
            task.state = TASK_STATE_DONE;
          }
        }
        if (task) {
          if (str != null) {
            task.resp += str;
          }
          if ((task.resp.length - task.modLastCheckedPos > 50) || (str == null)) {
            var startPos = Math.max(0, task.modLastCheckedPos - 10);
            if (doModeration(task.resp.substring(startPos))) {
              console.log(`[node] Moderation triggered for ${task.id}, user: ${task.user.name}, model: ${this.model}`);
              if (!task.user.bypass_moderation) {
                if (task.ondata) {
                  task.ondata(null, {
                    "e": " ",
                    "err": "moderation",
                    "mod": {
                      eng: 0,
                      suggestion: "stop"
                    },
                    "done": true
                  });
                }
                this.removeTask(task.id, true);
                task.state = TASK_STATE_DONE;
                return;
              }
            }
            task.modLastCheckedPos = task.resp.length;
          }
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


function checkAuthAndGetUser(req) {
  // Get authorization header
  const auth = req.headers['authorization'];
  if (!auth) {
    return false;
  }
  if (!auth.startsWith('Bearer ')) {
    return false;
  }
  const token = auth.substring(7);
  var user = tokenToUsers[token]
  if (!user) {
    return false;
  }
  return user;
}


var server

function tryFinishReqWithStr(res, str) {
  try {
    res.write(str);
    res.end();
  } catch (e) {
    console.log("[api] Error writing error response:", e.message);
  }
}

function httpReqHandler(req, res) {
  const headers = {
    /*
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type'*/
  };
  var user = checkAuthAndGetUser(req);
  if (req.url === '/api/chat' && req.method === 'POST') {
    if (!user) {
      tryFinishReqWithStr(res, `{"err":"unauthorized"}\n`);
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
        const id = allocReqID();
        const task = {
          state: 0,
          id: id,
          resp: '',
          modLastCheckedPos: 0,
          system: data.system,
          messages: data.messages,
          max_new_tokens: data.max_new_tokens,
          temperature: data.temperature,
          created_at: Math.floor(Date.now() / 1000),
          user: user,
        };
        const model = models[data.model];
        // Check atmost last 3 messages for moderation
        for (var i = Math.max(0, data.messages.length - 3); i < data.messages.length; i++) {
          if (doModeration(data.messages[i].content)) {
            console.log(`[api] Moderation triggered for ${id}, content: ${data.messages[i].content}, user: ${data.messages[i].role}`);
            if (!user.bypass_moderation) {
              tryFinishReqWithStr(res, `{"err":"moderation"}\n`);
              return;
            }
          }
        }
        if (!model) {
          console.log("[api] Unknown model:", data.model);
          tryFinishReqWithStr(res, `{"err":"unknown model"}\n`);
          return;
        }
        task.ondata = (data, err) => {
          if (err) {
            tryFinishReqWithStr(res, JSON.stringify(err) + '\n');
            return
          }
          if (data === null) {
            tryFinishReqWithStr(res, `{"done":true}\n`);
          } else {
            try {
              res.write(JSON.stringify({ o: data }) + '\n', (err) => {
                if (err) {
                  console.log("[api] Error writing to response:", err.message);
                  cancelTask(task);
                }
              });
            } catch (e) {
              console.log("[api] Error writing to response:", e.message);
              cancelTask(task);
            }

          }
        }
        model.queueTask(task);
        setTimeout(() => {
          if (task.state === 0) {
            console.log("[api] Timeout waiting for node:", task.id);
            tryFinishReqWithStr(res, `{"err":"timeout waiting for node"}\n`);
          }
        }, 30 * 1000);
        setTimeout(() => {
          if (task.state !== 2) {
            console.log("[api] Timeout waiting for finish:", task.id);
            cancelTask(task);
            tryFinishReqWithStr(res, `{"err":"timeout waiting for finish"}\n`);
          }
        }, 600 * 1000);
      } catch (e) {
        console.log("[api] Error parsing request body", e);
        console.log(body)
        tryFinishReqWithStr(res, `{"err":"invalid request"}\n`);
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


const defaultSystemPrompt = `You are a helpful assistant name Buddy.`

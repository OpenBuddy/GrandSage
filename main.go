package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// Task represents a task for the chat model.
type Task struct {
	State        atomic.Int32  `json:"-"`
	ID           uint32        `json:"id"`
	Model        string        `json:"model"`
	System       string        `json:"system"`
	Messages     []ChatMessage `json:"messages"`
	MaxNewTokens int           `json:"maxNewTokens"`
	ResponseChan chan []byte   `json:"-"` // channel for writing response
	CreatedAt    time.Time     `json:"createdAt"`
}

func (t *Task) WriteRespWithTimeout(msg []byte) bool {
	select {
	case t.ResponseChan <- msg:
		return true
	case <-time.After(time.Second * 10):
		log.Println("[task] Task", t.ID, "write response timeout", string(msg))
		return false
	}
}

func (t *Task) CloseWithError(msg string) {
	swapped := t.State.CompareAndSwap(TaskStatePending, TaskStateDone)
	if !swapped {
		swapped = t.State.CompareAndSwap(TaskStateRunning, TaskStateDone)
	}
	if !swapped {
		log.Println("[task] Task", t.ID, "is not pending or running, cannot close with error:", msg, t.State.Load())
		return
	}
	ret := fmt.Sprintf(`{"err":"%s"}`, msg)
	if !t.WriteRespWithTimeout([]byte(ret)) {
		return
	}
	t.WriteRespWithTimeout(nil)

}

func (t *Task) Finish() {
	swapped := t.State.CompareAndSwap(TaskStateRunning, TaskStateDone)
	if !swapped {
		log.Println("[task] Task", t.ID, "is not running, cannot finish")
		return
	}
	if !t.WriteRespWithTimeout([]byte(`{"done":true}`)) {
		return
	}
	t.WriteRespWithTimeout(nil)
}

const (
	TaskStateInvalid = 0
	TaskStatePending = 1
	TaskStateRunning = 2
	TaskStateDone    = 3
)

// ComputeNode represents a compute node that will process the tasks.
type ComputeNode struct {
	ProcessingTasks atomic.Int32    `json:"-"` // -1 if not connected
	Name            string          `json:"-"`
	Model           string          `json:"model"` // name of the model
	Token           string          `json:"token"` // token of the compute node
	MaxConcurrency  int             `json:"maxConcurrency"`
	WSLock          sync.Mutex      `json:"-"`
	Conn            *websocket.Conn `json:"-"`
	TaskChan        chan *Task      `json:"-"`
}

const (
	NodeStateNotConnected = 0
	NodeStateConnected    = 1
)

type User struct {
	Name             string `json:"-"`
	Token            string `json:"token"`
	RateLimitPerHour int    `json:"rateLimitPerHour"`
	SystemPrompt     string `json:"systemPrompt"`
}

var Config struct {
	ApiHost            string                  `json:"apiHost"`
	WSHost             string                  `json:"wsHost"`
	ComputeNodes       map[string]*ComputeNode `json:"computeNodes"`
	APIUsers           map[string]*User        `json:"apiUsers"`
	TaskMaxPendingTime int                     `json:"taskMaxPendingTime"`
}

type ChatMessage struct {
	Role    string `json:"role"` // "user" or "assistant"
	Content string `json:"content"`
}

type ModelState struct {
	UpdateCond *sync.Cond
	Nodes      []*ComputeNode
	TaskChan   chan *Task
}

var upgrader = websocket.Upgrader{} // use default options

var ApiUserTokenMap = make(map[string]*User)       // map of api users, not writable after initialization
var ComputeNodeMap = make(map[string]*ComputeNode) // map of compute nodes, not writable after initialization
var ModelStateMap = make(map[string]*ModelState)   // map of model states, not writable after initialization

func apiChatHandler(w http.ResponseWriter, r *http.Request) {
	// Set CORS headers, Allow all origins, allow Auth header
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	if r.Method != "POST" {
		// Only write CORS headers and return
		return
	}
	// Parse the request body
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		log.Println("[api] Error reading request body:", err)
	}
	var apiReq struct {
		ConversationID string        `json:"conversation_id"`
		Model          string        `json:"model"`
		System         string        `json:"system"`
		Messages       []ChatMessage `json:"messages"`
		MaxNewTokens   int           `json:"maxNewTokens"`
	}
	if err := json.Unmarshal(body, &apiReq); err != nil {
		log.Println("[api] Error parsing request body:", err)
	}
	model, ok := ModelStateMap[apiReq.Model]
	if !ok {
		log.Println("[api] Model", apiReq.Model, "not found")
		w.Write([]byte(`{"err":"model not found"}`))
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		log.Println("[api] Flusher not supported")
		w.Write([]byte(`{"err":"flusher not supported"}`))
		return
	}

	task := &Task{
		ID:           randomU32(),
		Model:        apiReq.Model,
		System:       apiReq.System,
		Messages:     apiReq.Messages,
		MaxNewTokens: apiReq.MaxNewTokens,
		ResponseChan: make(chan []byte, 100),
		CreatedAt:    time.Now(),
	}
	task.State.Store(TaskStatePending)
	defer task.State.Store(TaskStateDone)
	select {
	case model.TaskChan <- task:
		log.Println("[api] Task", task.ID, "sent to model queue", task.Model)
	default:
		log.Println("[api] Task", task.ID, "queue is full", task.Model)
		w.Write([]byte(`{"err":"model queue is full"}`))
		return
	}
	// Set response headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	// Wait for responses
	for {
		select {
		case resp := <-task.ResponseChan:
			if resp == nil {
				log.Println("[api] Task", task.ID, "finished")
				return
			}
			_, err := w.Write(resp)
			if err == nil {
				_, err = w.Write([]byte("\n"))
			}
			if err != nil {
				log.Println("[api] Error writing response:", err)
				return
			}

			flusher.Flush()
		case <-time.After(time.Second * 60):
			log.Println("[api] Task", task.ID, "timeout")
			task.CloseWithError("timeout")
			w.Write([]byte(`{"err":"timeout"}`))
			return
		}
	}

}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	// Get key from query string
	token := r.URL.Query().Get("token")
	node := ComputeNodeMap[token]
	if node == nil {
		log.Println("[ws] Invalid token:", token)
		return
	}
	model := ModelStateMap[node.Model]
	if model == nil {
		log.Println("[ws] Invalid model:", node.Model)
		return
	}
	// Upgrade to websocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("[ws] Error upgrading connection:", err)
		return
	}
	defer conn.Close()

	oldConn := node.Conn
	if oldConn != nil {
		oldConn.Close()
	}

	node.WSLock.Lock()
	defer node.WSLock.Unlock()
	node.ProcessingTasks.Store(0)
	defer func() {
		node.ProcessingTasks.Store(-1)
	}()
	node.Conn = conn
	finished := make(chan bool)
	defer func() {
		finished <- true
	}()
	var taskMap sync.Map
	stopReqChan := make(chan uint32, 100)
	defer func() {
		taskMap.Range(func(key, value interface{}) bool {
			task := value.(*Task)
			task.CloseWithError("node has gone away")
			return true
		})
	}()

	go func() {
		for {
			select {
			case <-finished:
				return
			case stopID := <-stopReqChan:
				conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"id":%d, "stop":true}`, stopID)))
			case task := <-node.TaskChan:
				if !task.State.CompareAndSwap(TaskStatePending, TaskStateRunning) {
					log.Println("[ws] Task", task.ID, "not pending", task.State.Load())
					continue
				}
				jsonData, err := json.Marshal(task)
				if err != nil {
					log.Println("[ws] Error marshaling task:", err)
					continue
				}
				taskMap.Store(task.ID, task)
				if err := conn.WriteMessage(websocket.TextMessage, jsonData); err != nil {
					task.CloseWithError("error writing message")
					log.Println("[ws] Error writing message:", err)
					conn.Close()

					return
				}
				node.ProcessingTasks.Add(1)

			}
		}

	}()
	// Read messages from the websocket
	for {
		mtype, message, err := conn.ReadMessage()
		if len(message) == 0 {
			continue
		}
		if mtype == websocket.TextMessage {
			log.Println("[ws] Received debug message:", node.Name, string(message))
			continue
		}
		if err != nil {
			log.Println("[ws] Error reading message:", err)
			break
		}
		if mtype == websocket.BinaryMessage {
			if len(message) >= 4 {
				taskID := binary.BigEndian.Uint32(message)
				v, ok := taskMap.Load(taskID)
				if !ok {
					log.Println("[ws] Task", taskID, "not found")
					continue
				}
				task := v.(*Task)
				if len(message) > 4 {
					if task.State.Load() != TaskStateRunning {
						log.Println("[ws] Task", taskID, "is not running, send stop signal")
						stopReqChan <- taskID
						taskMap.Delete(taskID)
						continue
					}
					if !task.WriteRespWithTimeout(message[4:]) {
						log.Println("[ws] Task", taskID, "response queue is full")
						taskMap.Delete(taskID)
					}
				} else if len(message) == 4 {
					log.Println("[ws] Task", taskID, "finished")
					node.ProcessingTasks.Add(-1)
					model.UpdateCond.Broadcast()
					task.Finish()
					taskMap.Delete(taskID)
				}
			}
		}
	}

}

func modelScheduler(modelState *ModelState) {
	tryIssueTask := func(task *Task) bool {
		for _, node := range modelState.Nodes {
			processingTasks := node.ProcessingTasks.Load()
			if processingTasks < 0 {
				continue
			}
			if processingTasks >= int32(node.MaxConcurrency) {
				continue
			}
			select {
			case node.TaskChan <- task:
				log.Println("[sc] Task", task.ID, "issued to node", node.Name)
				return true
			default:
				//log.Println("[sc] warning: node", node.Name, "task chan full")
				continue
			}
		}
		return false
	}
	for {
		task := <-modelState.TaskChan
		if task.State.Load() != TaskStatePending {
			log.Println("[sc] Task", task.ID, "not pending", task.State.Load())
			continue
		}
		if tryIssueTask(task) {
			continue
		}
		for {
			modelState.UpdateCond.Wait()
			if task.State.Load() != TaskStatePending {
				log.Println("[sc] Task", task.ID, "not pending", task.State.Load())
				break
			}
			if tryIssueTask(task) {
				break
			}
		}

	}
}

func main() {
	prepareConfig()

	apiServeMux := http.NewServeMux()
	apiServeMux.HandleFunc("/api/chat", apiChatHandler)
	go func() {
		log.Println("API server listening on", Config.ApiHost)
		httpServer := &http.Server{
			Addr:              Config.ApiHost,
			Handler:           apiServeMux,
			IdleTimeout:       60 * time.Second,
			ReadTimeout:       30 * time.Second,
			ReadHeaderTimeout: 30 * time.Second,
			WriteTimeout:      300 * time.Second,
			MaxHeaderBytes:    1 << 20,
		}
		log.Fatal(httpServer.ListenAndServe())
	}()

	wsServeMux := http.NewServeMux()
	wsServeMux.HandleFunc("/ws", wsHandler)
	go func() {
		log.Println("WS server listening on", Config.WSHost)
		log.Fatal(http.ListenAndServe(Config.WSHost, wsServeMux))
	}()

	for _, modelState := range ModelStateMap {
		go modelScheduler(modelState)
	}

	// Handle SIGTERM and Ctrl-C
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM, os.Interrupt)
	<-sigChan
	log.Println("Shutting down...")
}

func prepareConfig() {
	// If config.json
	cfgDataFile, err := os.Open("config.json")
	if err != nil {
		if os.IsNotExist(err) {
			log.Println("config.json not found, creating a new one")
			Config.ApiHost = ":8087"
			Config.WSHost = ":8088"
			Config.ComputeNodes = make(map[string]*ComputeNode)
			Config.ComputeNodes["first-node"] = &ComputeNode{
				Model:          "openbuddy-7b",
				Token:          randomStr(32),
				MaxConcurrency: 1,
			}
			Config.APIUsers = make(map[string]*User)
			Config.APIUsers["first-user"] = &User{
				Token:            randomStr(32),
				RateLimitPerHour: 1000,
			}
			cfgData, err := json.MarshalIndent(Config, "", "  ")
			if err != nil {
				log.Fatal(err)
			}
			err = ioutil.WriteFile("config.json", cfgData, 0600)
			if err != nil {
				log.Fatal(err)
			}
			os.Exit(0)
		} else {
			log.Fatal("unable to read config.json:", err)
		}
	}
	cfgData, err := ioutil.ReadAll(cfgDataFile)
	if err != nil {
		log.Fatal(err)
	}
	cfgDataFile.Close()
	if err := json.Unmarshal(cfgData, &Config); err != nil {
		log.Fatal("unable to parse config.json:", err)
	}
	for k, v := range Config.ComputeNodes {
		newNode := ComputeNode{
			Name:     k,
			Model:    v.Model,
			Token:    v.Token,
			TaskChan: make(chan *Task, 1),
		}
		newNode.ProcessingTasks.Store(-1)
		ComputeNodeMap[k] = &newNode
		modelState, ok := ModelStateMap[v.Model]
		if !ok {
			modelState = &ModelState{
				Nodes:      make([]*ComputeNode, 0, 10),
				UpdateCond: sync.NewCond(&sync.Mutex{}),
				TaskChan:   make(chan *Task, 1000),
			}
			ModelStateMap[v.Model] = modelState
		}
		modelState.Nodes = append(modelState.Nodes, &newNode)
	}
	for k, v := range Config.APIUsers {
		newUser := User{
			Name:             k,
			Token:            v.Token,
			RateLimitPerHour: v.RateLimitPerHour,
			SystemPrompt:     v.SystemPrompt,
		}
		_, ok := ApiUserTokenMap[v.Token]
		if ok {
			log.Fatal("duplicate api user token:", v.Token)
		}
		ApiUserTokenMap[v.Token] = &newUser
	}
	log.Println("config.json loaded")
}

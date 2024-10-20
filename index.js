const express = require("express");
const http = require("http");
const WebSocketService = require("./services/websocket.service");
const routes = require("./routes/index.route");
const { initialiseDummyData } = require("./controllers/index.controller");
const { redisService } = require("./services/redis.service");

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

app.use(express.json());

initialiseDummyData();

app.use("/", routes);

const webSocketService = new WebSocketService(server);

server.listen(port, () => {
  console.log(`Options trading app listening at http://localhost:${port}`);
});

module.exports = { app, webSocketService , redisService };

const express = require('express');
const app = express();
const http = require('http');
const dotenv = require('dotenv');
const routes = require('./routes/v1/routes');
const cors = require("cors");
const cookieParser = require("cookie-parser");
const db = require('./config/db.config');
const realtimeService = require('./services/realtime.service');

dotenv.config();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const corsOptions = {
    origin: true, 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions))
app.use(cookieParser());

app.use("/api/v1", routes);

const server = http.createServer(app);
realtimeService.init(server);

server.listen(process.env.PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});

const express = require('express');
const app = express();
const http = require('http');
const dotenv = require('dotenv');
const cron = require('node-cron');
const routes = require('./routes/v1/routes');
const cors = require("cors");
const cookieParser = require("cookie-parser");
const db = require('./config/db.config');
const realtimeService = require('./services/realtime.service');
const warmupService = require('./services/warmup.service');

dotenv.config();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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

// Warmup engine: advances every mailbox's daily send limit along its assigned ramp schedule,
// and enforces safety-tier pullbacks/stops against real domain bounce/complaint rates.
cron.schedule('5 0 * * *', () => {
    warmupService.runTick()
        .then((results) => console.log(`Warmup engine tick: ${results.length} mailbox(es) processed`))
        .catch((error) => console.error('Warmup engine tick failed:', error.message));
});

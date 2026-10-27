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
const campaignSendService = require('./services/campaignSend.service');
const imapInboxService = require('./services/imapInbox.service');

dotenv.config();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const corsOptions = {
    origin: true, 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-View-As-Workspace'],
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

// Campaign send engine: dispatches a small batch of pending leads per mailbox on every
// tick, so each mailbox's daily_limit is spread across its sending window rather than
// sent in a single burst. Runs only against campaigns currently inside their configured
// sending day/window.
cron.schedule('*/3 * * * *', () => {
    campaignSendService.runTick()
        .then((results) => console.log(`Campaign send engine tick: ${results.length} campaign(s) processed`))
        .catch((error) => console.error('Campaign send engine tick failed:', error.message));
});

// Maildoso mailboxes have no push channel (unlike SES -> SNS), so replies and bounces are
// pulled over IMAP. Overlap-guarded inside the service.
cron.schedule('*/2 * * * *', () => {
    imapInboxService.runTick()
        .then((results) => {
            const failed = results.filter((r) => r.error).length;
            const imported = results.reduce((sum, r) => sum + (r.imported || 0), 0);
            if (results.length) console.log(`IMAP poll: ${results.length} mailbox(es), ${imported} new message(s), ${failed} failed`);
        })
        .catch((error) => console.error('IMAP poll failed:', error.message));
});

// Maildoso domains have no CloudWatch feed, so their bounce rate is derived from our own send
// outcomes (see maildoso.service.js). Refreshed hourly so the 00:05 warmup tick's safety tiers
// act on current numbers instead of whatever the last manual "Recheck" left behind.
cron.schedule('0 * * * *', async () => {
    try {
        const maildosoService = require('./services/maildoso.service');
        const { rows } = await db.query(`SELECT domain FROM domains WHERE provider = 'Maildoso' AND is_deleted = FALSE`);
        for (const row of rows) await maildosoService.refreshDomainReputation(row.domain);
    } catch (error) {
        console.error('Maildoso domain reputation refresh failed:', error.message);
    }
});

// Keeps Replai's mailbox table in step with Maildoso: promotes mailboxes that finished setup,
// picks up ones created outside Replai, and mirrors failures. Cheap (two API calls).
cron.schedule('*/10 * * * *', () => {
    require('./services/maildoso.service').syncMailboxes()
        .catch((error) => console.error('Maildoso sync failed:', error.message));
});

// Warm-up network (super admin Deliverability module): the engine sends each warming mailbox's due emails and the
// seed replies; the poller reads the seed inboxes (placement, spam rescue, read/star, reply scheduling). Both are
// overlap-guarded and do nothing while the network is switched off.
cron.schedule('*/3 * * * *', () => {
    require('./services/warmnetEngine.service').runTick()
        .then((r) => { if (r && !r.skipped) console.log('Warm-up network tick:', JSON.stringify(r)); })
        .catch((error) => console.error('Warm-up network tick failed:', error.message));
});
cron.schedule('*/4 * * * *', async () => {
    try {
        const engine = require('./services/warmnetEngine.service');
        const settings = await engine.getSettings();
        if (!settings.enabled) return;
        await require('./services/warmnetSeed.service').pollAll(settings);
    } catch (error) {
        console.error('Warm-up seed poll failed:', error.message);
    }
});
cron.schedule('30 6 * * *', () => {
    require('./services/warmnetIp.service').checkAll()
        .catch((error) => console.error('Warm-up IP blocklist check failed:', error.message));
});

// Trial milestone emails (7/3/1 days before the end, and when it has ended). Hourly, deduplicated in the database.
try {
    require('./services/trialNotifier.service').start();
} catch (error) {
    console.error('Trial notifier could not start:', error.message);
}

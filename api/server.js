import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import Redis from "ioredis";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const redis = new Redis(process.env.REDIS_URL);
const DOMAIN = process.env.DOMAIN || "localhost";
const INBOX_TTL = parseInt(process.env.INBOX_TTL || "600", 10);
const MSG_TTL = parseInt(process.env.MSG_TTL || "600", 10);

const createLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const inboxLimiter  = rateLimit({ windowMs: 10_000, max: 60 });

function genLocalPart(){ return crypto.randomBytes(4).toString("hex"); }
async function inboxExists(local){ return !!(await redis.get(`inbox:${local}`)); }

// Create temp inbox
app.post("/create", createLimiter, async (req, res) => {
    const local = genLocalPart();
    const email = `${local}@${DOMAIN}`;
    const inbox = { local, email, created: Date.now(), expires_at: Date.now() + INBOX_TTL * 1000 };
    await redis.set(`inbox:${local}`, JSON.stringify(inbox), "EX", INBOX_TTL);
    await redis.lpush("inboxes", local);
    res.json({ email, local, expires_in: INBOX_TTL });
});

// List messages
app.get("/inbox/:local", inboxLimiter, async (req, res) => {
    const { local } = req.params;
    if (!/^[a-f0-9]{8}$/.test(local)) return res.status(400).json({ error: "Bad inbox id" });
    if (!(await inboxExists(local))) return res.status(404).json({ error: "Inbox not found or expired" });

    const ids = await redis.lrange(`msgs:${local}`, 0, -1);
    const msgs = [];
    for (const id of ids) {
        const raw = await redis.get(`msg:${id}`);
        if (raw) {
            const m = JSON.parse(raw);
            msgs.push({ id: m.id, from: m.from, subject: m.subject, received_at: m.received_at, preview: (m.body_plain || "").slice(0, 500) });
        }
    }
    res.json({ email: `${local}@${DOMAIN}`, messages: msgs });
});

// Get one message
app.get("/message/:id", async (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9]{16}$/.test(id)) return res.status(400).json({ error: "Bad message id" });
    const raw = await redis.get(`msg:${id}`);
    if (!raw) return res.status(404).json({ error: "Message not found" });
    res.json(JSON.parse(raw));
});

// (DEV) inject test message without SMTP
if (process.env.DEV_MODE === "1") {
    app.post("/debug/inject", async (req, res) => {
        try {
            const { local, from="Tester <tester@example.com>", subject="Hello", body="Test" } = req.body || {};
            if (!/^[a-f0-9]{8}$/.test(local)) return res.status(400).json({ error: "Bad local id" });
            const inbox = await redis.get(`inbox:${local}`);
            if (!inbox) return res.status(404).json({ error: "Inbox not found" });

            const id = crypto.randomBytes(8).toString("hex");
            const msg = {
                id,
                from,
                to: `${local}@${DOMAIN}`,
                subject,
                body_plain: body,
                body_html: "",
                attachments: [],
                received_at: Date.now()
            };
            await redis.set(`msg:${id}`, JSON.stringify(msg), "EX", MSG_TTL);
            await redis.lpush(`msgs:${local}`, id);
            await redis.expire(`msgs:${local}`, MSG_TTL);
            res.json({ ok: true, id });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "inject failed" });
        }
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on :${PORT}`));

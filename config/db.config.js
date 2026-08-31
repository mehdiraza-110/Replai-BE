const { Pool } = require("pg");
const env = require("dotenv");
env.config();

const db = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE || process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

db.query("SELECT 1")
  .then(() => console.log("✅ Postgres DB Connected!"))
  .catch((err) => {
    console.error("❌ DB CONNECTION ERROR:", err);
    process.exit(-1);
  });

db.on('error', (err) => {
  console.error("❌ DB ERROR:", err);
  process.exit(-1);
});

const query = (command, params) => db.query(command, params);

// Helper function to get a client from the pool for transactions
const getClient = async () => {
  const client = await db.connect();
  return client;
};

module.exports = {
  query,
  getClient,
  pool: db // Export pool for direct access if needed
};

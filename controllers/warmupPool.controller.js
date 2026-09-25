const warmupPoolService = require("../services/warmupPool.service");

const ALLOWED_LEAD_FILE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "txt"]);

async function getStats(req, res) {
  try {
    const data = await warmupPoolService.getStats();
    res.status(200).json({ success: true, message: "Warmup pool stats fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch warmup pool stats");
  }
}

async function addLeads(req, res) {
  try {
    const leads = Array.isArray(req.body?.leads) ? req.body.leads : [];
    if (leads.length === 0) {
      return res.status(400).json({ success: false, message: "Provide a non-empty 'leads' array", code: "LEADS_REQUIRED", data: null });
    }
    const data = await warmupPoolService.addLeads(leads);
    res.status(200).json({ success: true, message: "Leads added to warmup pool", data });
  } catch (error) {
    sendError(res, error, "Unable to add leads to warmup pool");
  }
}

async function addLeadsFromFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Attach a CSV, XLSX, XLS, or TXT file under the 'file' field", code: "LEAD_FILE_REQUIRED", data: null });
    }
    const extension = String(req.file.originalname || "").toLowerCase().split(".").pop();
    if (!ALLOWED_LEAD_FILE_EXTENSIONS.has(extension)) {
      return res.status(400).json({ success: false, message: "Unsupported file type. Upload a .csv, .xlsx, .xls, or .txt file.", code: "LEAD_FILE_TYPE_UNSUPPORTED", data: null });
    }
    const data = await warmupPoolService.addLeadsFromFile(req.file.buffer, req.file.originalname);
    res.status(200).json({ success: true, message: "Leads added to warmup pool", data });
  } catch (error) {
    sendError(res, error, "Unable to add leads to warmup pool");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "WARMUP_POOL_REQUEST_FAILED",
    data: null,
  });
}

module.exports = { getStats, addLeads, addLeadsFromFile };

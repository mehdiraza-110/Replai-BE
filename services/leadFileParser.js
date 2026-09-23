const XLSX = require("xlsx");

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

const FIELD_ALIASES = {
  email: ["email", "emailaddress", "primaryemail", "workemail", "e-mail"],
  fullName: ["fullname", "name", "contactname", "contactfullname", "leadname"],
  firstName: ["firstname", "fname", "first"],
  lastName: ["lastname", "lname", "last"],
  company: ["company", "companyname", "companynamecleaned", "organization", "org", "employer", "business"],
  role: ["role", "title", "jobtitle", "position", "designation"],
  phone: ["phone", "phonenumber", "mobile", "telephone", "cell", "cellphone"],
};

function normalizeHeader(header) {
  return String(header || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectFieldForHeader(normalized) {
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  if (normalized.includes("email")) return "email";
  if (normalized.includes("company") || normalized.includes("organization")) return "company";
  if (normalized.includes("fullname") || normalized === "name") return "fullName";
  if (normalized.includes("firstname")) return "firstName";
  if (normalized.includes("lastname")) return "lastName";
  if (normalized.includes("title") || normalized.includes("role") || normalized.includes("position")) return "role";
  if (normalized.includes("phone") || normalized.includes("mobile")) return "phone";
  return null;
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
}

function rowsFromWorkbookInput(input, type) {
  const workbook = XLSX.read(input, { type });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

/**
 * Parses a CSV/XLSX/XLS/TXT lead-import file into structured lead records.
 * Unmapped columns are preserved per-row in `raw` so no information from the
 * source file is discarded even when it doesn't map to a known field.
 */
function parseLeadsFile(buffer, originalName = "") {
  const extension = String(originalName).toLowerCase().split(".").pop();

  let rows = [];
  let headers = [];

  if (extension === "txt") {
    const text = buffer.toString("utf8");
    const firstLines = text.split(/\r?\n/, 5).join("\n");
    const looksDelimited = /[,\t;]/.test(firstLines);

    if (looksDelimited) {
      ({ rows, headers } = rowsFromWorkbookInput(text, "string"));
    } else {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      headers = ["email"];
      rows = lines.map((line) => ({ email: line }));
    }
  } else {
    ({ rows, headers } = rowsFromWorkbookInput(buffer, "buffer"));
  }

  const nonEmptyHeaders = headers.filter((header) =>
    rows.some((row) => row[header] !== null && row[header] !== undefined && String(row[header]).trim() !== "")
  );

  const fieldMap = {};
  for (const header of nonEmptyHeaders) {
    const field = detectFieldForHeader(normalizeHeader(header));
    if (field && !fieldMap[field]) fieldMap[field] = header;
  }

  if (!fieldMap.email) {
    for (const header of nonEmptyHeaders) {
      const sampleValues = rows.slice(0, 20).map((row) => row[header]).filter(Boolean);
      if (sampleValues.length && sampleValues.every((value) => EMAIL_PATTERN.test(String(value).trim()))) {
        fieldMap.email = header;
        break;
      }
    }
  }

  const seenEmails = new Set();
  const leads = [];
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    const rawEmail = fieldMap.email ? row[fieldMap.email] : null;
    const email = rawEmail ? String(rawEmail).trim().toLowerCase() : "";
    if (!email || !EMAIL_PATTERN.test(email)) {
      invalidCount += 1;
      continue;
    }
    if (seenEmails.has(email)) {
      duplicateCount += 1;
      continue;
    }
    seenEmails.add(email);

    const raw = {};
    for (const header of nonEmptyHeaders) {
      const value = row[header];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        raw[header] = typeof value === "string" ? value.trim() : value;
      }
    }

    const firstName = fieldMap.firstName ? cleanString(row[fieldMap.firstName]) : null;
    const lastName = fieldMap.lastName ? cleanString(row[fieldMap.lastName]) : null;
    let fullName = fieldMap.fullName ? cleanString(row[fieldMap.fullName]) : null;
    if (!fullName && (firstName || lastName)) fullName = [firstName, lastName].filter(Boolean).join(" ");

    leads.push({
      email,
      fullName: fullName || null,
      firstName: firstName || null,
      lastName: lastName || null,
      company: fieldMap.company ? cleanString(row[fieldMap.company]) : null,
      role: fieldMap.role ? cleanString(row[fieldMap.role]) : null,
      phone: fieldMap.phone ? cleanString(row[fieldMap.phone]) : null,
      raw,
    });
  }

  return {
    headers: nonEmptyHeaders,
    fieldMap,
    totalRows: rows.length,
    validCount: leads.length,
    invalidCount,
    duplicateCount,
    leads,
  };
}

module.exports = { parseLeadsFile };

/**
 * A model-independent safety net. Some claims are risky enough that a reply is never sent automatically unless our
 * own knowledge (Brain, knowledge base, rules) mentions the topic: if the prospect asks about a licence, insurance,
 * certification and so on, and nothing we wrote down covers it, the model cannot be trusted to know the answer.
 */
const RISKY_TOPICS = [
  { topic: "licensing", ask: /\blicen[sc](e|ed|es|ing)\b|\bpermit(s|ted)?\b/i, known: /\blicen[sc]|\bpermit/i },
  { topic: "insurance", ask: /\binsur(ed|ance)\b|\bliabilit(y|ies)\b|\bworkers'? ?comp/i, known: /\binsur|\bliabilit|\bworkers'? ?comp/i },
  { topic: "certifications", ask: /\bcertif(ied|ication|ications|icate)\b|\bcredential(s|ed)?\b/i, known: /\bcertif|\bcredential/i },
  { topic: "compliance and security", ask: /\b(soc ?2|iso ?27001|hipaa|gdpr|pci|compliant|compliance|security audit)\b/i, known: /\b(soc ?2|iso ?27001|hipaa|gdpr|pci|complian|security)/i },
  { topic: "background checks", ask: /\bbackground (check|screen)/i, known: /\bbackground/i },
  { topic: "guarantees", ask: /\bguarantee(d|s)?\b|\bwarrant(y|ies)\b|\brefund\b|\bmoney[- ]back\b/i, known: /\bguarantee|\bwarrant|\brefund|\bmoney[- ]back/i },
  { topic: "contracts", ask: /\bcontract(s)?\b|\bminimum commitment\b|\bcancellation\b|\bterms of service\b/i, known: /\bcontract|\bcommitment|\bcancel|\bterms/i },
];

/** @returns {string|null} a reason when a person must look first, else null. */
function ungroundedTopic({ prospectText, knowledgeText }) {
  for (const { topic, ask, known } of RISKY_TOPICS) {
    if (ask.test(prospectText || "") && !known.test(knowledgeText || "")) {
      return `The prospect asked about ${topic}, which is not covered in your knowledge base or Brain.`;
    }
  }
  return null;
}

module.exports = { ungroundedTopic, RISKY_TOPICS };

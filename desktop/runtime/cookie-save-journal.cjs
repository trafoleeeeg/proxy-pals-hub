const { createHash } = require("node:crypto");
const { profileId, revision } = require("./validation.cjs");
const { synchronizedCookies } = require("./cookie-identity.cjs");
const cookieHash = cookies => createHash("sha256").update(synchronizedCookies(cookies)).digest("hex");
function saveProof(value) {
  if (!value || typeof value !== "object") return null;
  try {
    if (!/^[0-9a-f]{64}$/.test(value.cookieHash)) return null;
    const cookiesUpdatedAt = revision(value.cookiesUpdatedAt);
    if (!cookiesUpdatedAt) return null;
    return { saveId: profileId(value.saveId), cookieHash: value.cookieHash, cookiesUpdatedAt };
  } catch { return null; }
}
function saveAttempts(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error("Invalid cookie save journal");
  const seen = new Set();
  return value.map(item => {
    const saveId = profileId(item?.saveId), snapshotRevision = revision(item?.snapshotRevision);
    if (seen.has(saveId) || !snapshotRevision || !/^[0-9a-f]{64}$/.test(item?.cookieHash)) throw new Error("Invalid cookie save journal");
    seen.add(saveId);
    return { saveId, snapshotRevision, cookieHash: item.cookieHash, baseRevision: revision(item.baseRevision) };
  });
}
function ownsProof(local, proof, cloud) {
  const verified = saveProof(proof);
  if (!local?.pending || !verified || verified.cookiesUpdatedAt !== revision(cloud.cookiesUpdatedAt) || verified.cookieHash !== cookieHash(cloud.cookies)) return false;
  return saveAttempts(local.saveAttempts).some(attempt => attempt.saveId === verified.saveId && attempt.cookieHash === verified.cookieHash && attempt.baseRevision === local.baseRevision);
}
module.exports = { cookieHash, saveProof, saveAttempts, ownsProof };

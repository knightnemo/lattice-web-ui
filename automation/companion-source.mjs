const tagPattern = /^companion\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;

export function parseCompanionPin(json) {
  const pin = JSON.parse(json);
  if (typeof pin?.snapshotTag !== "string" || !tagPattern.test(pin.snapshotTag) ||
      !["snapshotCommit", "originalCommit", "tree"].every((key) =>
        typeof pin[key] === "string" && shaPattern.test(pin[key]))) {
    throw new Error("Companion pin requires a companion/vX.Y.Z tag and full commit and tree SHAs.");
  }
  return pin;
}

export async function getStoredMap(key) {
  const storage = chrome.storage.session || chrome.storage.local;
  const result = await storage.get(key);
  const value = result?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function setStoredMap(key, value) {
  const storage = chrome.storage.session || chrome.storage.local;
  await storage.set({ [key]: value || {} });
}

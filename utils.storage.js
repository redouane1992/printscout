const Storage = {
  async get(key, fallback = null) {
    const res = await chrome.storage.local.get([key]);
    return res[key] ?? fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async del(key) {
    await chrome.storage.local.remove([key]);
  }
};

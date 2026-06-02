'use strict';

// getStorageQuotaWarning uses chrome.storage.local.getBytesInUse, which isn't
// available in Node. We mock chrome globally before requiring the module.

let mockBytesInUse = 0;
const MOCK_QUOTA = 10 * 1024 * 1024; // 10MB — chrome.storage.local default with unlimitedStorage

global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: MOCK_QUOTA,
      getBytesInUse: jest.fn(async () => mockBytesInUse),
      get: jest.fn(async () => ({})),
      set: jest.fn(async () => {}),
      clear: jest.fn(async () => {}),
    },
  },
};

const { getStorageQuotaWarning } = require('../new/dat-matcher/popup.js');

describe('getStorageQuotaWarning', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null when storage is under 90%', async () => {
    mockBytesInUse = MOCK_QUOTA * 0.50; // 50%
    const result = await getStorageQuotaWarning();
    expect(result).toBeNull();
  });

  test('returns warning string at 90% usage', async () => {
    mockBytesInUse = MOCK_QUOTA * 0.91; // 91%
    const result = await getStorageQuotaWarning();
    expect(result).toMatch(/91%/);
    expect(result).toMatch(/remove/i);
  });

  test('returns full-storage error at 95% usage', async () => {
    mockBytesInUse = MOCK_QUOTA * 0.96; // 96%
    const result = await getStorageQuotaWarning();
    expect(result).toMatch(/Storage full/i);
  });

  test('returns null if getBytesInUse throws (graceful degradation)', async () => {
    chrome.storage.local.getBytesInUse.mockRejectedValueOnce(new Error('unavailable'));
    const result = await getStorageQuotaWarning();
    expect(result).toBeNull();
  });

  test('returns null at exactly 89% (boundary)', async () => {
    mockBytesInUse = MOCK_QUOTA * 0.89;
    const result = await getStorageQuotaWarning();
    expect(result).toBeNull();
  });

  test('returns warning at exactly 90% (boundary)', async () => {
    mockBytesInUse = MOCK_QUOTA * 0.90;
    const result = await getStorageQuotaWarning();
    expect(result).toMatch(/90%/);
  });
});

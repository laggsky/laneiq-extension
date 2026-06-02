'use strict';

// validateLicenseKey uses chrome.storage.local and fetch. Both are mocked here.

let storedData = {};

global.chrome = {
  storage: {
    local: {
      QUOTA_BYTES: 10 * 1024 * 1024,
      getBytesInUse: jest.fn(async () => 0),
      get: jest.fn(async (keys) => {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map(k => [k, storedData[k]]));
        }
        return storedData;
      }),
      set: jest.fn(async (obj) => { Object.assign(storedData, obj); }),
      clear: jest.fn(async () => { storedData = {}; }),
    },
  },
};

global.fetch = jest.fn();

const { validateLicenseKey } = require('../new/dat-matcher/popup.js');

function mockFetchValid(email = 'test@example.com') {
  fetch.mockResolvedValueOnce({
    json: async () => ({ valid: true, expires: new Date(Date.now() + 86400000).toISOString(), email }),
  });
}

function mockFetchInvalid() {
  fetch.mockResolvedValueOnce({
    json: async () => ({ valid: false, expires: null, email: null }),
  });
}

function mockFetchNetworkError() {
  fetch.mockRejectedValueOnce(new Error('network error'));
}

beforeEach(() => {
  storedData = {};
  jest.clearAllMocks();
});

describe('validateLicenseKey', () => {
  test('returns invalid for empty key', async () => {
    const result = await validateLicenseKey('');
    expect(result.valid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('returns invalid for whitespace-only key', async () => {
    const result = await validateLicenseKey('   ');
    expect(result.valid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('returns invalid for non-string key', async () => {
    const result = await validateLicenseKey(null);
    expect(result.valid).toBe(false);
  });

  test('calls backend and returns valid for a good key', async () => {
    mockFetchValid();
    const result = await validateLicenseKey('LANEIQ-GOOD-KEY-1234');
    expect(result.valid).toBe(true);
    expect(result.cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('stores key and timestamp in chrome.storage on valid response', async () => {
    mockFetchValid();
    await validateLicenseKey('LANEIQ-GOOD-KEY-1234');
    expect(storedData.licenseKey).toBe('LANEIQ-GOOD-KEY-1234');
    expect(storedData.licenseValid).toBe(true);
    expect(storedData.licenseCheckedAt).toBeDefined();
  });

  test('returns valid from cache within 24h grace period (no network call)', async () => {
    // Pre-populate cache as if a previous check succeeded
    storedData = {
      licenseKey: 'LANEIQ-CACHED-KEY-5678',
      licenseValid: true,
      licenseCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    };
    const result = await validateLicenseKey('LANEIQ-CACHED-KEY-5678');
    expect(result.valid).toBe(true);
    expect(result.cached).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('re-validates after grace period expires (calls backend)', async () => {
    // Cache is 25h old — expired
    storedData = {
      licenseKey: 'LANEIQ-OLD-KEY-9999',
      licenseValid: true,
      licenseCheckedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    mockFetchValid();
    const result = await validateLicenseKey('LANEIQ-OLD-KEY-9999');
    expect(result.valid).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('returns invalid for a bad key from backend', async () => {
    mockFetchInvalid();
    const result = await validateLicenseKey('LANEIQ-BAD-KEY-0000');
    expect(result.valid).toBe(false);
    expect(result.cached).toBe(false);
  });

  test('trims whitespace from key before validating', async () => {
    mockFetchValid();
    await validateLicenseKey('  LANEIQ-TRIM-ME-1234  ');
    const callBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(callBody.key).toBe('LANEIQ-TRIM-ME-1234');
  });

  test('fails open on network error if fresh cache exists', async () => {
    storedData = {
      licenseKey: 'LANEIQ-OFFLINE-KEY-1111',
      licenseValid: true,
      licenseCheckedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30min ago
    };
    mockFetchNetworkError();
    const result = await validateLicenseKey('LANEIQ-OFFLINE-KEY-1111');
    expect(result.valid).toBe(true);
    expect(result.cached).toBe(true);
  });

  test('fails closed on network error with no prior cache', async () => {
    mockFetchNetworkError();
    const result = await validateLicenseKey('LANEIQ-NO-CACHE-2222');
    expect(result.valid).toBe(false);
  });

  test('fails closed on network error with expired cache', async () => {
    storedData = {
      licenseKey: 'LANEIQ-EXPIRED-3333',
      licenseValid: true,
      licenseCheckedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h ago
    };
    mockFetchNetworkError();
    const result = await validateLicenseKey('LANEIQ-EXPIRED-3333');
    expect(result.valid).toBe(false);
  });
});

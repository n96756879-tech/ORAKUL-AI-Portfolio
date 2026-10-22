import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateGrantInput, grantCredits } from '../src/lib/supabase/credits';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('validateGrantInput', () => {
  test('rejects missing userId', () => {
    const r = validateGrantInput({ amount: 10, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  test('rejects empty userId', () => {
    const r = validateGrantInput({ userId: '  ', amount: 10, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
  });

  test('rejects invalid UUID format for userId', () => {
    const r = validateGrantInput({ userId: 'not-a-uuid', amount: 10, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.error, /формат/);
    }
  });

  test('rejects missing idempotencyKey', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 10, reason: 'test', idempotencyKey: '' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  test('rejects NaN amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: NaN, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /целым числом/);
  });

  test('rejects Infinity amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: Infinity, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
  });

  test('rejects fractional amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 10.5, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /целым числом/);
  });

  test('rejects zero amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 0, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /положительным/);
  });

  test('rejects negative amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: -5, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /положительным/);
  });

  test('rejects amount exceeding MAX_GRANT_AMOUNT', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 100001, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /лимит/);
  });

  test('accepts amount exactly at MAX_GRANT_AMOUNT', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 100000, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, true);
  });

  test('rejects missing reason', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 10, reason: '', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /причину/);
  });

  test('rejects whitespace-only reason', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 10, reason: '   ', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /причину/);
  });

  test('rejects reason exceeding MAX_REASON_LENGTH after trim', () => {
    const long = 'a'.repeat(501);
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: 10, reason: long, idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /слишком длин/);
  });

  test('accepts valid input and trims reason and userId', () => {
    const r = validateGrantInput({
      userId: '  550e8400-e29b-41d4-a716-446655440000  ',
      amount: 10,
      reason: '  Тестовое начисление  ',
      idempotencyKey: '  key123  ',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.userId, '550e8400-e29b-41d4-a716-446655440000');
      assert.equal(r.amount, 10);
      assert.equal(r.reason, 'Тестовое начисление');
      assert.equal(r.idempotencyKey, 'key123');
    }
  });

  test('rejects string amount (type coercion not allowed)', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: '10', reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
  });

  test('rejects boolean amount', () => {
    const r = validateGrantInput({ userId: '550e8400-e29b-41d4-a716-446655440000', amount: true, reason: 'test', idempotencyKey: 'k1' });
    assert.equal(r.ok, false);
  });
});

describe('grantCredits idempotency contract (RPC response handling)', () => {
  function mockClient(rpcResponse: { data: unknown; error: { code?: string; message?: string } | null }): SupabaseClient {
    return {
      rpc: async () => rpcResponse,
    } as unknown as SupabaseClient;
  }

  const baseInput = {
    userId: '550e8400-e29b-41d4-a716-446655440000',
    amount: 100,
    reason: 'bonus',
    createdBy: 'admin@test.com',
    idempotencyKey: 'key-abc-123',
  };

  test('returns isDuplicate=true for safe duplicate (same params)', async () => {
    const client = mockClient({
      data: [{ new_balance: 150, transaction_id: 'tx-1', is_duplicate: true }],
      error: null,
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.isDuplicate, true);
      assert.equal(result.newBalance, 150);
      assert.equal(result.transactionId, 'tx-1');
    }
  });

  test('returns isDuplicate=false for fresh grant', async () => {
    const client = mockClient({
      data: [{ new_balance: 100, transaction_id: 'tx-2', is_duplicate: false }],
      error: null,
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.isDuplicate, false);
      assert.equal(result.newBalance, 100);
    }
  });

  test('returns 409 conflict when same key used with different parameters', async () => {
    const client = mockClient({
      data: null,
      error: { code: '40901', message: 'idempotency key conflict: same key with different parameters' },
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
      assert.match(result.error, /другими параметрами/);
    }
  });

  test('returns 409 for legacy duplicate key error (23505)', async () => {
    const client = mockClient({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 409);
    }
  });

  test('returns 404 when target user not found', async () => {
    const client = mockClient({
      data: null,
      error: { code: 'P0002', message: 'target user not found' },
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 404);
    }
  });

  test('returns 500 for unexpected DB error', async () => {
    const client = mockClient({
      data: null,
      error: { code: 'XX000', message: 'internal server error' },
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
    }
  });

  test('returns 500 for malformed RPC response', async () => {
    const client = mockClient({
      data: [{ new_balance: 'not-a-number', transaction_id: 'tx-3', is_duplicate: false }],
      error: null,
    });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
    }
  });

  test('returns 500 for null RPC response without error', async () => {
    const client = mockClient({ data: null, error: null });
    const result = await grantCredits(client, baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
    }
  });
});

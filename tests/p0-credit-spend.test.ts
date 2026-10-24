// Address-specific tests for the credit-spend lifecycle helpers.
//
// Scope split (important):
//  - Sections 1-3 exercise the REAL production helpers from src/lib/supabase/credits.ts
//    against a fake Supabase client, so PostgREST response-shape handling and error
//    mapping are genuinely executed.
//  - Section 4 asserts structural invariants of the SQL migration. It is a static
//    contract check, NOT proof of PostgreSQL behaviour: this repo has no PostgreSQL
//    (no psql/pg/docker/pglite/pg-mem available), so concurrency, advisory locking and
//    transaction rollback below cannot be executed here. See the report for the
//    explicit list of what stays unproven.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  reserveCreditSpend,
  consumeCreditSpend,
  releaseCreditSpend,
} from '../src/lib/supabase/credits';
import type { SupabaseClient } from '@supabase/supabase-js';

type RpcCall = { fn: string; args: Record<string, unknown> };
type RpcReply = { data: unknown; error: { code?: string; message?: string } | null };

function mockClient(
  reply: RpcReply | ((call: RpcCall) => RpcReply),
  calls: RpcCall[] = [],
): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const call = { fn, args };
      calls.push(call);
      return typeof reply === 'function' ? reply(call) : reply;
    },
  } as unknown as SupabaseClient;
}

const baseInput = {
  userId: '550e8400-e29b-41d4-a716-446655440000',
  amount: 10,
  reason: 'analysis',
  idempotencyKey: 'analysis:550e8400-e29b-41d4-a716-446655440000:op:op-aaaaaaaa',
};

describe('reserveCreditSpend: PostgREST RETURNS TABLE contract', () => {
  test('fresh reservation: reads data[0] and returns reservation id + balance', async () => {
    const calls: RpcCall[] = [];
    const client = mockClient(
      { data: [{ reservation_id: 'res-1', balance_after: 90, is_duplicate: false }], error: null },
      calls,
    );

    const result = await reserveCreditSpend(client, baseInput);

    assert.deepEqual(result, { ok: true, reservationId: 'res-1', balanceAfter: 90 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'reserve_credit_spend');
    assert.deepEqual(calls[0].args, {
      p_user_id: baseInput.userId,
      p_amount: 10,
      p_reason: 'analysis',
      p_idempotency_key: baseInput.idempotencyKey,
    });
  });

  test('duplicate replay (same key + params): returns the prior reservation, not a second one', async () => {
    const client = mockClient({
      data: [{ reservation_id: 'res-1', balance_after: 90, is_duplicate: true }],
      error: null,
    });

    const first = await reserveCreditSpend(client, baseInput);
    const second = await reserveCreditSpend(client, baseInput);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.reservationId, 'res-1');
      assert.equal(second.reservationId, 'res-1');
      assert.equal(second.balanceAfter, 90);
    }
  });

  test('insufficient balance maps to insufficient_funds with 402', async () => {
    const client = mockClient({
      data: null,
      error: { code: '23514', message: 'insufficient balance' },
    });

    const result = await reserveCreditSpend(client, baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'insufficient_funds');
      assert.equal(result.status, 402);
    }
  });

  test('same key with different parameters maps to idempotency_conflict (409)', async () => {
    const client = mockClient({
      data: null,
      error: { code: '40901', message: 'idempotency key conflict: same key with different parameters' },
    });

    const result = await reserveCreditSpend(client, { ...baseInput, amount: 25 });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'idempotency_conflict');
      assert.equal(result.status, 409);
    }
  });

  test('replay after released reservation is a controlled conflict, never ok=true', async () => {
    const client = mockClient({
      data: null,
      error: {
        code: '40901',
        message: 'idempotency key conflict: reservation was released, a new operation id is required',
      },
    });

    const result = await reserveCreditSpend(client, baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'idempotency_conflict');
      assert.equal(result.status, 409);
      assert.equal('reservationId' in result, false);
    }
  });

  test('unknown user maps to user_not_found (404)', async () => {
    const client = mockClient({
      data: null,
      error: { code: 'P0002', message: 'target user not found' },
    });

    const result = await reserveCreditSpend(client, baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'user_not_found');
      assert.equal(result.status, 404);
    }
  });

  test('unexpected RPC error maps to db_error (500), never to success', async () => {
    const client = mockClient({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.reserve_credit_spend' },
    });

    const result = await reserveCreditSpend(client, baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'db_error');
      assert.equal(result.status, 500);
    }
  });

  test('missing RPC is a server error, not an idempotency conflict (real PGRST202 message)', async () => {
    // PostgREST renders the searched parameter list into this message, and one parameter is
    // literally named p_idempotency_key. Substring matching on "idempotency" therefore turned
    // "function not found" (migration not applied) into a 409 telling the client to retry with
    // a new operation id, which can never help.
    const client = mockClient({
      data: null,
      error: {
        code: 'PGRST202',
        message:
          'Could not find the function public.reserve_credit_spend(p_amount, p_idempotency_key, p_reason, p_user_id) in the schema cache',
      },
    });

    const result = await reserveCreditSpend(client, baseInput);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.notEqual(result.reason, 'idempotency_conflict');
      assert.equal(result.status, 500);
      assert.equal(result.reason, 'db_error');
    }
  });

  test('empty / malformed RPC payload is an error, not a silent success', async () => {
    const payloads: unknown[] = [
      null,
      undefined,
      [],
      {},
      [{ balance_after: 90 }],
      [{ reservation_id: null }],
      [{ reservation_id: '' }],
      'res-1',
    ];

    for (const data of payloads) {
      const client = mockClient({ data, error: null });
      const result = await reserveCreditSpend(client, baseInput);
      assert.equal(result.ok, false, `payload ${JSON.stringify(data)} must not succeed`);
      if (!result.ok) {
        assert.equal(result.reason, 'invalid_response');
        assert.equal(result.status, 500);
      }
    }
  });
});

describe('consumeCreditSpend: RETURNS TABLE as array of rows', () => {
  test('successful consume returns success:true and passes reservation + key', async () => {
    const calls: RpcCall[] = [];
    const client = mockClient({ data: [{ success: true }], error: null }, calls);

    const result = await consumeCreditSpend(client, 'res-1', 'analysis:u:op:x');

    assert.deepEqual(result, { success: true });
    assert.equal(calls[0].fn, 'consume_credit_spend');
    assert.deepEqual(calls[0].args, {
      p_reservation_id: 'res-1',
      p_idempotency_key: 'analysis:u:op:x',
    });
  });

  test('repeated consume of an already consumed reservation stays idempotent (success:true)', async () => {
    const client = mockClient({ data: [{ success: true }], error: null });

    const first = await consumeCreditSpend(client, 'res-1', 'analysis:u:op:x');
    const second = await consumeCreditSpend(client, 'res-1', 'analysis:u:op:x');

    assert.deepEqual(first, { success: true });
    assert.deepEqual(second, { success: true });
  });

  test('missing idempotency key is forwarded as empty string, not dropped', async () => {
    const calls: RpcCall[] = [];
    const client = mockClient({ data: [{ success: true }], error: null }, calls);

    await consumeCreditSpend(client, 'res-1');

    assert.equal(calls[0].args.p_idempotency_key, '');
  });

  test('RPC error is surfaced as failure with the underlying reason', async () => {
    const client = mockClient({
      data: null,
      error: { code: '23514', message: 'cannot consume a released reservation' },
    });

    const result = await consumeCreditSpend(client, 'res-1', 'k');

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(String(result.reason), /released/);
    }
  });

  test('empty / unexpected payload is a failure, not success (no ?? true fallback)', async () => {
    const payloads: unknown[] = [null, undefined, [], {}, [{ success: false }], [{ success: 'true' }], true, 'ok'];

    for (const data of payloads) {
      const client = mockClient({ data, error: null });
      const result = await consumeCreditSpend(client, 'res-1', 'k');
      assert.equal(result.success, false, `payload ${JSON.stringify(data)} must not succeed`);
      if (!result.success) assert.equal(result.reason, 'invalid_response');
    }
  });
});

describe('releaseCreditSpend: RETURNS TABLE as array of rows', () => {
  test('successful release returns released:true', async () => {
    const calls: RpcCall[] = [];
    const client = mockClient({ data: [{ released: true, refunded_amount: 10 }], error: null }, calls);

    const result = await releaseCreditSpend(client, 'res-1', 'analysis:u:op:x');

    assert.deepEqual(result, { released: true });
    assert.equal(calls[0].fn, 'release_credit_spend');
    assert.equal(calls[0].args.p_reservation_id, 'res-1');
  });

  test('repeated release stays released:true (refund already applied once)', async () => {
    const client = mockClient({ data: [{ released: true, refunded_amount: 0 }], error: null });

    const first = await releaseCreditSpend(client, 'res-1', 'k');
    const second = await releaseCreditSpend(client, 'res-1', 'k');

    assert.deepEqual(first, { released: true });
    assert.deepEqual(second, { released: true });
  });

  test('release after consume is a failure, never a refund', async () => {
    const client = mockClient({
      data: null,
      error: { code: '23514', message: 'cannot release a consumed reservation' },
    });

    const result = await releaseCreditSpend(client, 'res-1', 'k');

    assert.equal(result.released, false);
    if (!result.released) assert.match(String(result.reason), /consumed/);
  });

  test('empty / unexpected payload is a failure, not success (no ?? true fallback)', async () => {
    const payloads: unknown[] = [null, undefined, [], {}, [{ released: false }], [{ released: 'true' }], true, 'ok'];

    for (const data of payloads) {
      const client = mockClient({ data, error: null });
      const result = await releaseCreditSpend(client, 'res-1', 'k');
      assert.equal(result.released, false, `payload ${JSON.stringify(data)} must not succeed`);
      if (!result.released) assert.equal(result.reason, 'invalid_response');
    }
  });
});

// ---------------------------------------------------------------------------
// Static contract checks on the migration.
// These are NOT behavioural tests: they cannot prove transaction or concurrency
// semantics without a real PostgreSQL instance. They pin the ORDERING of the
// statements that make the algorithm correct (lock -> idempotency read -> insert
// -> balance check -> deduct), which is exactly what a later edit could break.
// ---------------------------------------------------------------------------
describe('migration 20261022000000: idempotency invariants (static contract)', () => {
  const sql = readFileSync(
    path.join(process.cwd(), 'supabase', 'migrations', '20261022000000_credit_spend_rpc.sql'),
    'utf8',
  );

  function fnBody(name: string, nextMarker: string): string {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    assert.ok(start >= 0, `${name} must be defined`);
    const end = sql.indexOf(nextMarker, start);
    assert.ok(end > start, `${name} body must be delimited`);
    return sql.slice(start, end);
  }

  const reserveBody = () =>
    fnBody('reserve_credit_spend', 'REVOKE EXECUTE ON FUNCTION public.reserve_credit_spend');
  const consumeBody = () =>
    fnBody('consume_credit_spend', 'CREATE OR REPLACE FUNCTION public.release_credit_spend');
  const releaseBody = () =>
    fnBody('release_credit_spend', 'REVOKE EXECUTE ON FUNCTION public.release_credit_spend');

  function positions(body: string, needles: string[]): number[] {
    return needles.map((n) => {
      const at = body.indexOf(n);
      assert.ok(at >= 0, `expected statement not found: ${n}`);
      return at;
    });
  }

  test('reserve serializes concurrent callers sharing a key (advisory xact lock)', () => {
    assert.match(
      reserveBody(),
      /pg_advisory_xact_lock\(hashtextextended\('credit_spend_reserve:' \|\| p_idempotency_key/,
    );
  });

  test('reserve acquires the key lock BEFORE reading idempotency state and BEFORE writing', () => {
    const body = reserveBody();
    const [lock, read, insert, deduct] = positions(body, [
      'pg_advisory_xact_lock',
      'FROM public.credit_spend_reservations\n    WHERE idempotency_key = p_idempotency_key;',
      'INSERT INTO public.credit_spend_reservations',
      'UPDATE public.credit_balances',
    ]);
    assert.ok(lock < read, 'advisory lock must precede the idempotency lookup');
    assert.ok(lock < insert, 'advisory lock must precede the reservation insert');
    assert.ok(lock < deduct, 'advisory lock must precede the balance deduction');
  });

  test('reserve checks balance and inserts reservation BEFORE deducting, so a failure leaves nothing behind', () => {
    const body = reserveBody();
    const [insert, insufficient, deduct] = positions(body, [
      'INSERT INTO public.credit_spend_reservations',
      "RAISE EXCEPTION 'insufficient balance'",
      'UPDATE public.credit_balances',
    ]);
    assert.ok(insert < insufficient, 'reservation row is created before the balance check');
    assert.ok(insufficient < deduct, 'balance check precedes the deduction');
    assert.match(body, /RAISE EXCEPTION 'insufficient balance' USING ERRCODE = '23514'/);
  });

  // Returns the exact source of an `IF <marker> THEN ... END IF;` statement, found by
  // matching the terminating `END IF;` instead of an arbitrary character window. The
  // blocks asserted below are flat (no nested IF), so the first `END IF;` is the end.
  function ifBlock(body: string, startMarker: string): string {
    const start = body.indexOf(startMarker);
    assert.ok(start >= 0, `expected block not found: ${startMarker}`);
    const end = body.indexOf('END IF;', start);
    assert.ok(end > start, `unterminated block: ${startMarker}`);
    return body.slice(start, end + 'END IF;'.length);
  }

  test('reserve rejects a released reservation instead of returning ok=true with the old id', () => {
    const body = reserveBody();
    const guard = ifBlock(body, "IF v_existing_status = 'released' THEN");

    // The guard must terminate the call with a controlled conflict...
    assert.match(guard, /RAISE EXCEPTION 'idempotency key conflict: reservation was released[^']*' USING ERRCODE = '40901';/);
    // ...and must not hand the released (already refunded) reservation id back to the caller.
    assert.doesNotMatch(guard, /RETURN QUERY/);
    assert.doesNotMatch(guard, /v_existing_id/);

    // The replay path for 'reserved'/'consumed' sits after the guard and is the only
    // place allowed to return the prior reservation id.
    const replayAt = body.indexOf('RETURN QUERY SELECT v_existing_id');
    assert.ok(replayAt > body.indexOf(guard) + guard.length, 'replay return must come after the released guard');
  });

  test('reserve validates user_id, amount and reason when the key is reused', () => {
    assert.match(
      reserveBody(),
      /v_existing_user != p_user_id OR v_existing_amt != p_amount OR btrim\(v_existing_reason\) != btrim\(p_reason\)/,
    );
  });

  test('reserve absorbs a unique violation instead of leaking it as an unhandled 500', () => {
    assert.match(reserveBody(), /EXCEPTION WHEN unique_violation THEN/);
  });

  test('reservation idempotency key is globally unique in the schema', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_spend_res_idem\s+ON public\.credit_spend_reservations \(idempotency_key\)/,
    );
  });

  test('ledger keys are derived per reservation, so reserve and release never collide', () => {
    // credit_transactions.idempotency_key is globally UNIQUE: the reserve deduction and
    // the release refund must therefore use different, per-reservation key spaces.
    assert.match(reserveBody(), /'reserve:' \|\| v_res_id::text/);
    assert.match(releaseBody(), /'release:' \|\| p_reservation_id::text/);
    assert.doesNotMatch(reserveBody(), /'release:'/);
    assert.doesNotMatch(releaseBody(), /'reserve:'/);
    // The refund journal row is not optional: a swallowed key collision would refund the
    // balance and flip the status with no ledger row, hiding the inconsistency. The insert
    // must stay unguarded so a collision aborts the transaction. Scope the check to the
    // journal insert only: ON CONFLICT (user_id) on credit_balances stays legitimate.
    assert.match(
      releaseBody(),
      /INSERT INTO public\.credit_transactions[\s\S]*'release:' \|\| p_reservation_id::text/,
    );
    const releaseTx = releaseBody().slice(
      releaseBody().indexOf('INSERT INTO public.credit_transactions'),
    );
    assert.doesNotMatch(releaseTx, /ON CONFLICT/);
  });

  test('the caller idempotency key is not reused as a ledger key (no cross-table collision)', () => {
    const reserveTx = reserveBody().slice(
      reserveBody().indexOf('INSERT INTO public.credit_transactions'),
    );
    assert.doesNotMatch(reserveTx, /VALUES \([^)]*p_idempotency_key/);
  });

  test('consume and release both lock the reservation row and reject the opposite terminal status', () => {
    const consume = consumeBody();
    assert.match(consume, /FOR UPDATE/);
    assert.match(consume, /IF v_status = 'consumed' THEN\s+RETURN QUERY SELECT true;/);
    assert.match(consume, /IF v_status = 'released' THEN\s+RAISE EXCEPTION 'cannot consume a released reservation'/);

    const release = releaseBody();
    assert.match(release, /FOR UPDATE/);
    assert.match(release, /IF v_status = 'released' THEN\s+RETURN QUERY SELECT true, 0::bigint;/);
    assert.match(release, /IF v_status = 'consumed' THEN\s+RAISE EXCEPTION 'cannot release a consumed reservation'/);
  });

  test('release refunds only after the status transition is decided, and never twice', () => {
    const release = releaseBody();
    const [releasedGuard, refund, statusUpdate] = positions(release, [
      "IF v_status = 'released' THEN",
      'DO UPDATE SET balance = credit_balances.balance + v_amt',
      "SET status = 'released'",
    ]);
    assert.ok(releasedGuard < refund, 'released short-circuit must precede the refund');
    assert.ok(refund < statusUpdate, 'refund must precede the status flip');
  });
});


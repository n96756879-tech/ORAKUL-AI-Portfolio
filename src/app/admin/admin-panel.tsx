'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';

type AdminUser = {
  id: string;
  email: string;
  createdAt: string;
  emailConfirmedAt: string | null;
  balance?: number;
  balanceExists?: boolean;
};

type Transaction = {
  id: string;
  amount: number;
  reason: string;
  reference: string | null;
  created_by: string | null;
  created_at: string;
};

type UsersResponse = {
  users: AdminUser[];
  page: number;
  perPage: number;
  total: number;
  truncated: boolean;
};

type TransactionsResponse = {
  balance: number;
  balanceExists: boolean;
  transactions: Transaction[];
};

type GrantResponse = {
  ok: true;
  newBalance: number;
  transactionId: string;
  isDuplicate: boolean;
} | {
  error: string;
};

export default function AdminPanel({ adminEmail }: { adminEmail: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersTruncated, setUsersTruncated] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceExists, setBalanceExists] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [grantResult, setGrantResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingTx, setLoadingTx] = useState(false);
  const [granting, setGranting] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users?page=1');
      const data: UsersResponse | { error: string } = await res.json();
      if (!res.ok) {
        setError((data as { error: string }).error || 'Ошибка загрузки пользователей.');
        return;
      }
      const d = data as UsersResponse;
      setUsers(d.users);
      setUsersTruncated(d.truncated);
    } catch {
      setError('Сбой связи с сервером.');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const selectUser = useCallback(async (userId: string) => {
    setSelectedUserId(userId);
    setBalance(null);
    setTransactions([]);
    setGrantResult(null);
    setError(null);
    setLoadingTx(true);
    try {
      const res = await fetch(`/api/admin/transactions?userId=${encodeURIComponent(userId)}`);
      const data: TransactionsResponse | { error: string } = await res.json();
      if (!res.ok) {
        setError((data as { error: string }).error || 'Ошибка загрузки данных.');
        return;
      }
      const d = data as TransactionsResponse;
      setBalance(d.balance);
      setBalanceExists(d.balanceExists);
      setTransactions(d.transactions);
    } catch {
      setError('Сбой связи с сервером.');
    } finally {
      setLoadingTx(false);
    }
  }, []);

  const handleGrant = useCallback(async () => {
    if (!selectedUserId) return;
    if (!idempotencyKey) {
      setError('Отсутствует ключ идемпотентности. Обновите страницу.');
      return;
    }
    setGranting(true);
    setError(null);
    setGrantResult(null);
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: selectedUserId,
          amount: Number(amount),
          reason,
          idempotencyKey,
        }),
      });
      const data: GrantResponse = await res.json();
      if (!res.ok || !('ok' in data)) {
        setError((data as { error: string }).error || 'Ошибка начисления.');
        return;
      }
      const d = data as Extract<GrantResponse, { ok: true }>;
      setBalance(d.newBalance);
      setBalanceExists(true);
      setGrantResult(
        d.isDuplicate
          ? 'Повторный запрос — начисление не выполнено (идемпотентность).'
          : `Начислено. Новый баланс: ${d.newBalance}. ID операции: ${d.transactionId.slice(0, 8)}.`,
      );
      setIdempotencyKey(`${selectedUserId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setUsers((prev) =>
        prev.map((u) => (u.id === selectedUserId ? { ...u, balance: d.newBalance, balanceExists: true } : u)),
      );
      const txRes = await fetch(`/api/admin/transactions?userId=${encodeURIComponent(selectedUserId)}`);
      if (txRes.ok) {
        const txData: TransactionsResponse = await txRes.json();
        setBalance(txData.balance);
        setBalanceExists(txData.balanceExists);
        setTransactions(txData.transactions);
      }
    } catch {
      setError('Сбой связи с сервером.');
    } finally {
      setGranting(false);
    }
  }, [selectedUserId, amount, reason, idempotencyKey]);

  const generateIdempotencyKey = useCallback(() => {
    setIdempotencyKey(`${selectedUserId ?? 'na'}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }, [selectedUserId]);

  return (
    <div className="w-full max-w-5xl flex flex-col items-center pt-8 sm:pt-16 pb-16">
      <header className="text-center mb-10 w-full">
        <div className="flex justify-end w-full mb-2">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <Link href="/dashboard" className="text-cyan-400 hover:text-cyan-300">Кабинет</Link>
            <Link href="/" className="text-slate-400 hover:text-cyan-300">На главную</Link>
          </div>
        </div>
        <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
          Админ-панель
        </h1>
        <p className="text-xs text-slate-500 mt-2 font-mono">{adminEmail}</p>
      </header>

      {error && (
        <div className="w-full mb-6 rounded-lg border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {grantResult && (
        <div className="w-full mb-6 rounded-lg border border-green-800/60 bg-green-950/40 px-4 py-3 text-sm text-green-300">
          {grantResult}
        </div>
      )}

      <section className="w-full mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase">Пользователи</h2>
          <button
            onClick={fetchUsers}
            disabled={loadingUsers}
            className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold disabled:opacity-50"
          >
            {loadingUsers ? 'Загрузка…' : 'Загрузить'}
          </button>
        </div>
        {users.length === 0 ? (
          <p className="text-sm text-slate-500">Нажмите «Загрузить» для получения списка.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/50">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 uppercase">
                   <tr>
                     <th className="px-3 py-2 text-left">Email</th>
                     <th className="px-3 py-2 text-left">Регистрация</th>
                     <th className="px-3 py-2 text-left">Подтв.</th>
                     <th className="px-3 py-2 text-left">UUID</th>
                     <th className="px-3 py-2 text-right">Баланс</th>
                     <th className="px-3 py-2"></th>
                   </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      className={`border-t border-slate-800/60 ${selectedUserId === u.id ? 'bg-cyan-950/30' : ''}`}
                    >
                      <td className="px-3 py-2 text-slate-200">{u.email || '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{u.createdAt?.slice(0, 10) ?? '—'}</td>
                      <td className="px-3 py-2">
                        {u.emailConfirmedAt ? (
                          <span className="text-green-400 text-xs">да</span>
                        ) : (
                          <span className="text-amber-400 text-xs">нет</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 font-mono">{u.id.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-right font-mono text-cyan-400">
                        {typeof u.balance === 'number' ? u.balance : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => selectUser(u.id)}
                          className="text-cyan-400 hover:text-cyan-300 text-xs"
                        >
                          Выбрать
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {usersTruncated && (
              <p className="text-xs text-amber-400 mt-2">
                Список неполный — отображены первые {users.length} пользователей. Пагинация будет добавлена позже.
              </p>
            )}
          </>
        )}
      </section>

      {selectedUserId && (
        <section className="w-full mb-8">
          <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-4">
            Баланс и история
          </h2>
          {loadingTx ? (
            <p className="text-sm text-slate-500">Загрузка…</p>
          ) : (
            <>
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3 mb-4">
                <span className="text-xs text-slate-400">Текущий баланс: </span>
                <span className="text-lg font-bold text-cyan-400">{balance ?? 0}</span>
                {!balanceExists && (
                  <span className="text-xs text-slate-500 ml-2">(нет записи — отображается 0)</span>
                )}
              </div>
              {transactions.length === 0 ? (
                <p className="text-sm text-slate-500">Операций пока нет.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/50">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-slate-400 uppercase">
                      <tr>
                        <th className="px-3 py-2 text-left">Дата</th>
                        <th className="px-3 py-2 text-left">Кол-во</th>
                        <th className="px-3 py-2 text-left">Причина</th>
                        <th className="px-3 py-2 text-left">Инициатор</th>
                        <th className="px-3 py-2 text-left">Ссылка</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.map((tx) => (
                        <tr key={tx.id} className="border-t border-slate-800/60">
                          <td className="px-3 py-2 text-slate-400 text-xs">{tx.created_at?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                          <td className={`px-3 py-2 font-mono ${tx.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {tx.amount > 0 ? '+' : ''}{tx.amount}
                          </td>
                          <td className="px-3 py-2 text-slate-200">{tx.reason}</td>
                          <td className="px-3 py-2 text-xs text-slate-500 font-mono">{tx.created_by?.slice(0, 8) ?? '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-500 font-mono">{tx.reference ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {selectedUserId && (
        <section className="w-full">
          <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-4">
            Начисление кредитов
          </h2>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-4 space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Количество (целое, 1—100000)</label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={1}
                step={1}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                placeholder="Например: 10"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Причина (обязательно)</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                placeholder="Например: Тестовое начисление"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Ключ идемпотентности</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={idempotencyKey}
                  onChange={(e) => setIdempotencyKey(e.target.value)}
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 font-mono"
                  placeholder="Сгенерируйте ключ"
                />
                <button
                  onClick={generateIdempotencyKey}
                  className="px-3 py-2 rounded border border-slate-700 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Новый
                </button>
              </div>
            </div>
            <button
              onClick={handleGrant}
              disabled={granting || !amount || !reason.trim() || !idempotencyKey}
              className="w-full px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm disabled:opacity-50"
            >
              {granting ? 'Начисление…' : 'Начислить'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

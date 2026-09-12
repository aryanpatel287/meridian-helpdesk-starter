import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../app/api';

const STATUSES = ['', 'open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['', 'P1', 'P2', 'P3'];

export default function TicketList() {
  const user = useSelector((s) => s.auth.user);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [sortBy, setSortBy] = useState('created_at');
  const [breached, setBreached] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let ignore = false;
    setLoading(true);

    const params = new URLSearchParams({
      page,
      search: debouncedSearch,
      status,
      priority,
      sortBy,
      order: 'desc',
    });
    if (breached) params.set('breached', 'true');

    api(`/tickets?${params.toString()}`)
      .then((data) => {
        if (!ignore) {
          setRows(data.rows);
          setTotal(data.total);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => { ignore = true; };
  }, [page, debouncedSearch, status, priority, sortBy, breached]);

  async function handleDelete(id) {
    await api(`/tickets/${id}`, { method: 'DELETE' });
    setRows(rows.filter((r) => r.id !== id));
  }

  const pageCount = Math.ceil(total / 20);

  return (
    <div className="ticket-list">
      <h1>Tickets</h1>

      <div className="filters">
        <input
          placeholder="Search subject..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s || 'Any status'}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{p || 'Any priority'}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => { setSortBy(e.target.value); setPage(1); }}>
          <option value="created_at">Created</option>
          <option value="updated_at">Updated</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={breached}
            onChange={(e) => { setBreached(e.target.checked); setPage(1); }}
          />
          Breached only
        </label>
      </div>

      {loading && <p>Loading...</p>}

      <table>
        <thead>
          <tr>
            <th>#</th><th>Subject</th><th>Status</th><th>Priority</th>
            <th>Assignee</th><th>Comments</th><th>Created</th><th>SLA</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td>{t.id}</td>
              <td><Link to={`/tickets/${t.id}`}>{t.subject}</Link></td>
              <td>{t.status}</td>
              <td>{t.priority}</td>
              <td>{t.assignee_name || '-'}</td>
              <td>{t.comment_count}</td>
              <td>{new Date(t.created_at).toLocaleString()}</td>
              <td>
                {t.sla_breached && (
                  <span className="badge-breached">SLA Breached</span>
                )}
              </td>
              <td>
                {user?.role === 'admin' && (
                  <button onClick={() => handleDelete(t.id)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pageCount || 1} - {total} tickets</span>
        <button disabled={page >= pageCount} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

import { query } from '../db/pool.js';

const PAGE_SIZE = 20;

// SLA helper generating SQL fragments for response timestamp and deadline
function slaFragments() {
    return {
        // Earliest comment by a same-org agent/admin
        firstResponseAt: `MIN(
            CASE
                WHEN author.role IN ('agent', 'admin')
                 AND author.org_id = t.org_id
                THEN c.created_at
            END
        )`,

        // SLA deadline based on priority target hours (P1: 4h, P2: 24h, P3: 72h)
        slaDeadline: `TIMESTAMPADD(HOUR,
            CASE t.priority
                WHEN 'P1' THEN 4
                WHEN 'P2' THEN 24
                WHEN 'P3' THEN 72
                ELSE 72
            END,
            t.created_at
        )`,
    };
}

/**
 * Paginated ticket list for current organisation with search, filters, and SLA fields.
 */
export async function listTickets({
    orgId,
    page = 1,
    search = '',
    status,
    priority,
    sortBy = 'created_at',
    order = 'desc',
    breached,
}) {
    const innerWhere = ['t.org_id = ?'];
    const innerParams = [orgId];

    if (search) {
        innerWhere.push('t.subject LIKE ?');
        innerParams.push(`%${search}%`);
    }
    if (status) {
        innerWhere.push('t.status = ?');
        innerParams.push(status);
    }
    if (priority) {
        innerWhere.push('t.priority = ?');
        innerParams.push(priority);
    }

    const innerWhereSql = innerWhere.join(' AND ');
    const offset = (page - 1) * PAGE_SIZE;

    const orderDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortClauses = {
        created_at: `t.created_at ${orderDir}`,
        updated_at: `t.updated_at ${orderDir}`,
        status:     `t.status ${orderDir}`,
        priority:   `CASE t.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END ASC, t.created_at DESC`,
    };
    const orderByClause = sortClauses[sortBy] || sortClauses.created_at;

    const { firstResponseAt, slaDeadline } = slaFragments();

    // Breach condition used in row and count queries for pagination consistency
    const breachExpr = `CASE
        WHEN first_response_at IS NULL THEN NOW() > sla_deadline
        ELSE first_response_at > sla_deadline
    END`;

    const outerWhere = breached === true ? `WHERE ${breachExpr} = 1` : '';

    // CTE computes SLA fields; outer SELECT filters by breach before LIMIT/OFFSET
    const rows = await query(
        `WITH ticket_sla AS (
            SELECT
                t.id,
                t.org_id,
                t.subject,
                t.status,
                t.priority,
                t.created_at,
                t.updated_at,
                t.requester_id,
                t.assignee_id,
                u.name  AS assignee_name,
                r.name  AS requester_name,
                ${firstResponseAt} AS first_response_at,
                ${slaDeadline}     AS sla_deadline
            FROM tickets t
            LEFT JOIN users    u      ON u.id       = t.assignee_id
            JOIN       users    r      ON r.id       = t.requester_id
            LEFT JOIN comments  c      ON c.ticket_id = t.id
            LEFT JOIN users    author  ON author.id   = c.author_id
            WHERE ${innerWhereSql}
            GROUP BY
                t.id, t.org_id, t.subject, t.status, t.priority,
                t.created_at, t.updated_at, t.requester_id, t.assignee_id,
                u.name, r.name
        )
        SELECT
            t.*,
            ${breachExpr} AS sla_breached
        FROM ticket_sla t
        ${outerWhere}
        ORDER BY ${orderByClause}
        LIMIT ? OFFSET ?`,
        [...innerParams, PAGE_SIZE, offset],
    );

    // Convert MySQL 0/1 to boolean
    for (const row of rows) {
        row.sla_breached = Boolean(row.sla_breached);
    }

    // Attach comment count per row
    for (const row of rows) {
        const [{ c }] = await query(
            'SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ?',
            [row.id],
        );
        row.comment_count = c;
    }

    // Count total matching tickets (uses CTE when breach filter is active)
    let total;
    if (breached === true) {
        const [{ total: t }] = await query(
            `WITH ticket_sla AS (
                SELECT
                    t.id,
                    ${firstResponseAt} AS first_response_at,
                    ${slaDeadline}     AS sla_deadline
                FROM tickets t
                LEFT JOIN comments c    ON c.ticket_id = t.id
                LEFT JOIN users author  ON author.id   = c.author_id
                WHERE ${innerWhereSql}
                GROUP BY t.id, t.created_at, t.priority
            )
            SELECT COUNT(*) AS total
            FROM ticket_sla
            WHERE ${breachExpr} = 1`,
            innerParams,
        );
        total = t;
    } else {
        const [{ total: t }] = await query(
            `SELECT COUNT(*) AS total FROM tickets t WHERE ${innerWhereSql}`,
            innerParams,
        );
        total = t;
    }

    return { rows, total, page, pageSize: PAGE_SIZE };
}

/**
 * Fetch a single ticket by ID with SLA fields, scoped to the caller's organisation.
 */
export async function getTicketById(id, orgId) {
    const { firstResponseAt, slaDeadline } = slaFragments();

    const rows = await query(
        `WITH sla AS (
            SELECT
                t.*,
                u.name  AS assignee_name,
                r.name  AS requester_name,
                r.email AS requester_email,
                ${firstResponseAt} AS first_response_at,
                ${slaDeadline}     AS sla_deadline
            FROM tickets t
            LEFT JOIN users    u      ON u.id       = t.assignee_id
            JOIN       users    r      ON r.id       = t.requester_id
            LEFT JOIN comments  c      ON c.ticket_id = t.id
            LEFT JOIN users    author  ON author.id   = c.author_id
            WHERE t.id = ? AND t.org_id = ?
            GROUP BY
                t.id, t.org_id, t.subject, t.body, t.status, t.priority,
                t.requester_id, t.assignee_id, t.created_at, t.updated_at,
                u.name, r.name, r.email
        )
        SELECT
            sla.*,
            CASE
                WHEN first_response_at IS NULL THEN NOW() > sla_deadline
                ELSE first_response_at > sla_deadline
            END AS sla_breached
        FROM sla`,
        [id, orgId],
    );

    if (rows[0]) {
        rows[0].sla_breached = Boolean(rows[0].sla_breached);
    }
    return rows[0] || null;
}

export async function listComments(ticketId) {
    return query(
        `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
           FROM comments c
           JOIN users u ON u.id = c.author_id
          WHERE c.ticket_id = ?
          ORDER BY c.created_at ASC`,
        [ticketId],
    );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
    const result = await query(
        `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
         VALUES (?, ?, ?, ?, ?)`,
        [orgId, subject, body, priority, requesterId],
    );
    return getTicketById(result.insertId, orgId);
}

export async function assignTicket(ticketId, assigneeId, orgId) {
    const ticket = await getTicketById(ticketId, orgId);
    if (!ticket) return null;

    if (ticket.assignee_id) {
        return { conflict: true, ticket };
    }

    const [agent] = await query('SELECT id, name FROM users WHERE id = ?', [assigneeId]);

    await query('UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?', [
        assigneeId,
        'pending',
        ticketId,
    ]);
    return { conflict: false, assignedTo: agent, ticket: await getTicketById(ticketId, orgId) };
}

export async function deleteTicket(id) {
    await query('DELETE FROM tickets WHERE id = ?', [id]);
}

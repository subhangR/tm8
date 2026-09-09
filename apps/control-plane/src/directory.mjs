import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class DirectoryError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

export class Directory {
  constructor(pool) { this.pool = pool; }
  async transaction(fn) {
    const connection = await this.pool.connect();
    try {
      await connection.query('begin');
      const result = await fn(connection);
      await connection.query('commit');
      return result;
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally { connection.release(); }
  }

  async admin(sessionSecret) {
    const session = await this.session(sessionSecret);
    if (!session.is_admin) throw new DirectoryError('administrator_required', 403);
    return session;
  }

  async session(sessionSecret) {
    if (!sessionSecret) throw new DirectoryError('authentication_required', 401);
    const { rows } = await this.pool.query(`select s.id session_id, a.* from tm8_directory.sessions s
      join tm8_directory.accounts a on a.id = s.account_id
      where s.secret_hash = $1 and s.revoked_at is null and s.expires_at > now() and a.status = 'active'`, [hash(sessionSecret)]);
    if (!rows[0]) throw new DirectoryError('invalid_session', 401);
    return rows[0];
  }

  async registerMachine(sessionSecret, input) {
    const actor = await this.admin(sessionSecret);
    const id = input.machineId ?? randomUUID();
    const credential = secret();
    const { rows } = await this.pool.query(`insert into tm8_directory.machines
      (id,name,public_origin,provider,capacity,credential_hash) values($1,$2,$3,$4,$5,$6)
      returning id,name,public_origin,provider,capacity,state,allocated`,
    [id, input.name, input.publicOrigin, input.provider, input.capacity, hash(credential)]);
    await this.audit(actor.id, 'machine.register', id);
    return { ...rows[0], enrollmentCredential: credential };
  }

  async machine(machineId, credential) {
    if (!credential) throw new DirectoryError('machine_authentication_required', 401);
    const { rows } = await this.pool.query('select * from tm8_directory.machines where id=$1 and credential_hash=$2', [machineId, hash(credential)]);
    if (!rows[0]) throw new DirectoryError('invalid_machine_credential', 401);
    return rows[0];
  }

  async heartbeat(machineId, credential) {
    const machine = await this.machine(machineId, credential);
    await this.pool.query(`update tm8_directory.machines set last_heartbeat_at=now(),
      state=case when state='draining' then state else 'ready' end where id=$1`, [machineId]);
    return { leaseSeconds: 30, capacity: machine.capacity };
  }

  async configureMachine(sessionSecret, machineId, capacity, draining) {
    const actor = await this.admin(sessionSecret);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new DirectoryError('invalid_capacity', 400);
    const { rowCount } = await this.pool.query(`update tm8_directory.machines set capacity=$2,
      state=case when $3 then 'draining' when last_heartbeat_at > now()-interval '90 seconds' then 'ready' else 'offline' end
      where id=$1 and allocated <= $2`, [machineId, capacity, draining]);
    if (!rowCount) throw new DirectoryError('capacity_below_allocation_or_machine_missing');
    await this.audit(actor.id, 'machine.configure', machineId);
  }

  async invite(sessionSecret, email, targetMachineId = null, spaceId = null) {
    if (spaceId) throw new DirectoryError('create_space_invitations_on_the_assigned_node', 400);
    const actor = await this.admin(sessionSecret);
    return this.transaction(async client => {
      const accountId = randomUUID();
      const { rows } = await client.query(`insert into tm8_directory.accounts(id,identity_id,email)
        values($1,$2,$3) on conflict(lower(email)) do update set email=excluded.email returning id`,
      [accountId, randomUUID(), email.toLowerCase()]);
      if (targetMachineId) {
        const assigned = await client.query('select machine_id from tm8_directory.assignments where account_id=$1', [rows[0].id]);
        if (assigned.rows[0] && assigned.rows[0].machine_id !== targetMachineId) throw new DirectoryError('cross_machine_sharing_unsupported');
      }
      const code = secret();
      const id = randomUUID();
      await client.query(`insert into tm8_directory.invitations(id,account_id,code_hash,target_machine_id,space_id,created_by,expires_at)
        values($1,$2,$3,$4,$5,$6,now()+interval '7 days')`, [id, rows[0].id, hash(code), targetMachineId, spaceId, actor.id]);
      return { id, code, accountId: rows[0].id };
    });
  }

  async nodeInvite(machineId, credential, input) {
    const actor = await this.lease(machineId, credential, input.sessionId);
    return this.transaction(async client => {
      // The enrolled node has verified space administration and persisted the
      // invitation. Its stable source ID makes retries safe after a lost reply.
      const existing = await client.query('select * from tm8_directory.invitations where source_invitation_id=$1', [input.invitationId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.target_machine_id !== machineId || row.created_by !== actor.account_id || row.code_hash !== hash(input.code)) throw new DirectoryError('invitation_conflict');
        return { id: row.id };
      }
      const accountId = randomUUID();
      const account = await client.query(`insert into tm8_directory.accounts(id,identity_id,email) values($1,$2,$3)
        on conflict(lower(email)) do update set email=excluded.email returning id`, [accountId, randomUUID(), input.email.toLowerCase()]);
      const assigned = await client.query('select machine_id from tm8_directory.assignments where account_id=$1', [account.rows[0].id]);
      if (assigned.rows[0] && assigned.rows[0].machine_id !== machineId) throw new DirectoryError('cross_machine_sharing_unsupported');
      const id = randomUUID();
      await client.query(`insert into tm8_directory.invitations(id,account_id,code_hash,target_machine_id,space_id,created_by,expires_at,source_invitation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8)`, [id, account.rows[0].id, hash(input.code), machineId, input.spaceId, actor.account_id, input.expiresAt, input.invitationId]);
      return { id };
    });
  }
  async nodeRevokeInvitation(machineId, credential, invitationId) {
    await this.machine(machineId, credential);
    await this.pool.query(`update tm8_directory.invitations set revoked_at=now() where source_invitation_id=$1 and target_machine_id=$2`, [invitationId, machineId]);
    return { ok: true };
  }

  /** Only a verified Supabase user enters here; email is not an identity key. */
  async login(user, invitationCode, parentSessionId = null) {
    if (user?.tm8Method !== 'github') throw new DirectoryError('github_authentication_required', 403);
    if (!user?.id || !user.email || !user.email_confirmed_at) throw new DirectoryError('verified_email_required', 403);
    return this.transaction(async client => {
      let { rows } = await client.query('select * from tm8_directory.accounts where auth_subject=$1 for update', [user.id]);
      let account = rows[0];
      const github = user.tm8Method === 'github';
      if (github && !/^[0-9]{1,20}$/.test(user.tm8GithubSubject ?? '')) throw new DirectoryError('github_identity_required', 401);
      if (parentSessionId) {
        const parent = await client.query(`select account_id from tm8_directory.sessions where id=$1 and revoked_at is null and expires_at>now()`, [parentSessionId]);
        if (!github || !account || parent.rows[0]?.account_id !== account.id || account.status !== 'active') throw new DirectoryError('explicit_link_session_required', 403);
        if (account.github_subject && account.github_subject !== user.tm8GithubSubject) throw new DirectoryError('different_github_account_already_linked');
        await client.query('update tm8_directory.accounts set github_subject=$2 where id=$1', [account.id, user.tm8GithubSubject]);
        account.github_subject = user.tm8GithubSubject;
      }
      if (account && github && account.github_subject !== user.tm8GithubSubject) throw new DirectoryError('github_account_link_required', 403);
      if (!account) {
        if (!invitationCode) throw new DirectoryError('invitation_required', 403);
        const invited = await client.query(`select a.*, i.id invitation_id from tm8_directory.invitations i
          join tm8_directory.accounts a on a.id=i.account_id where i.code_hash=$1 and i.revoked_at is null
          and i.accepted_at is null and i.expires_at>now() and lower(a.email)=lower($2) for update of a,i`, [hash(invitationCode), user.email]);
        account = invited.rows[0];
        if (!account || account.auth_subject || account.status === 'suspended') throw new DirectoryError('invalid_invitation', 403);
        await client.query(`update tm8_directory.accounts set auth_subject=$2,status='active',github_subject=$3 where id=$1`, [account.id, user.id, github ? user.tm8GithubSubject : null]);
        await client.query('update tm8_directory.invitations set accepted_at=now() where id=$1', [account.invitation_id]);
      } else {
        if (account.status !== 'active') throw new DirectoryError('account_suspended', 403);
        if (invitationCode) {
          const invited = await client.query(`select i.*, w.machine_id assigned_machine from tm8_directory.invitations i
            left join tm8_directory.assignments w on w.account_id=i.account_id
            where i.code_hash=$1 and i.account_id=$2 and i.revoked_at is null
            and i.accepted_at is null and i.expires_at>now() for update of i`, [hash(invitationCode), account.id]);
          const invitation = invited.rows[0];
          if (!invitation) throw new DirectoryError('invalid_invitation', 403);
          const pinned = await client.query(`select target_machine_id from tm8_directory.invitations where account_id=$1 and accepted_at is not null
            and target_machine_id is not null order by accepted_at asc limit 1`, [account.id]);
          const target = invitation.assigned_machine ?? pinned.rows[0]?.target_machine_id;
          if (invitation.target_machine_id && target && invitation.target_machine_id !== target) {
            throw new DirectoryError('cross_machine_sharing_unsupported');
          }
          await client.query('update tm8_directory.invitations set accepted_at=now() where id=$1', [invitation.id]);
        }
      }
      const token = secret();
      await client.query(`insert into tm8_directory.sessions(id,account_id,secret_hash,expires_at)
        values($1,$2,$3,now()+interval '12 hours')`, [randomUUID(), account.id, hash(token)]);
      return { token, accountId: account.id, identityId: account.identity_id };
    });
  }
  async checkInvitation(email, code) {
    if (typeof code !== 'string' || code.length > 128) throw new DirectoryError('invalid_invitation', 403);
    const { rowCount } = await this.pool.query(`select 1 from tm8_directory.invitations i
      join tm8_directory.accounts a on a.id=i.account_id where lower(a.email)=lower($1)
      and i.code_hash=$2 and i.accepted_at is null and i.revoked_at is null and i.expires_at>now() and a.status<>'suspended'`, [email, hash(code)]);
    if (!rowCount) throw new DirectoryError('invalid_invitation', 403);
  }

  async allocate(sessionSecret) {
    const account = await this.session(sessionSecret);
    return this.transaction(async client => {
      // Account lock makes retries and simultaneous browser logins idempotent.
      await client.query('select id from tm8_directory.accounts where id=$1 for update', [account.id]);
      const existing = await client.query('select * from tm8_directory.assignments where account_id=$1', [account.id]);
      if (existing.rows[0]) return existing.rows[0];
      const invitation = await client.query(`select target_machine_id from tm8_directory.invitations
        where account_id=$1 and accepted_at is not null and target_machine_id is not null order by accepted_at asc limit 1`, [account.id]);
      const target = invitation.rows[0]?.target_machine_id ?? null;
      const eligible = await client.query(`select * from tm8_directory.machines
        where state='ready' and last_heartbeat_at>now()-interval '90 seconds' and allocated<capacity
        and ($1::uuid is null or id=$1) order by allocated::float/capacity,id for update skip locked limit 1`, [target]);
      const machine = eligible.rows[0];
      if (!machine) throw new DirectoryError('waiting_for_capacity', 503);
      await client.query('update tm8_directory.machines set allocated=allocated+1 where id=$1', [machine.id]);
      const result = await client.query(`insert into tm8_directory.assignments(account_id,machine_id,workspace_id,operation_id)
        values($1,$2,$3,$4) returning *`, [account.id, machine.id, randomUUID(), randomUUID()]);
      return result.rows[0];
    });
  }

  async issueHandoff(sessionSecret) {
    const account = await this.session(sessionSecret);
    const assignment = await this.allocate(sessionSecret);
    const { rows } = await this.pool.query(`select public_origin from tm8_directory.machines where id=$1
      and state='ready' and last_heartbeat_at>now()-interval '90 seconds'`, [assignment.machine_id]);
    if (!rows[0]) throw new DirectoryError('assigned_machine_unavailable', 503);
    const code = secret();
    await this.pool.query(`insert into tm8_directory.handoffs(code_hash,session_id,machine_id,expires_at)
      values($1,$2,$3,now()+interval '60 seconds')`, [hash(code), account.session_id, assignment.machine_id]);
    return { redirectUrl: `${rows[0].public_origin}/auth/handoff#code=${encodeURIComponent(code)}` };
  }

  async redeemHandoff(machineId, credential, code) {
    await this.machine(machineId, credential);
    return this.transaction(async client => {
      const result = await client.query(`update tm8_directory.handoffs h set redeemed_at=now()
        from tm8_directory.sessions s,tm8_directory.accounts a,tm8_directory.assignments w
        where h.code_hash=$1 and h.machine_id=$2 and h.redeemed_at is null and h.expires_at>now()
        and s.id=h.session_id and s.revoked_at is null and s.expires_at>now()
        and a.id=s.account_id and a.status='active' and w.account_id=a.id and w.machine_id=$2 and w.state<>'suspended'
        returning s.id session_id,a.id account_id,a.identity_id,a.email,w.workspace_id,w.operation_id`, [hash(code), machineId]);
      if (!result.rows[0]) throw new DirectoryError('invalid_handoff', 401);
      const invitations = await client.query(`select source_invitation_id from tm8_directory.invitations where account_id=$1
        and target_machine_id=$2 and accepted_at is not null and revoked_at is null and expires_at>now() and source_invitation_id is not null`, [result.rows[0].account_id, machineId]);
      return { ...result.rows[0], invitationIds: invitations.rows.map(row => row.source_invitation_id), leaseSeconds: 30 };
    });
  }

  async lease(machineId, credential, sessionId) {
    await this.machine(machineId, credential);
    const { rows } = await this.pool.query(`select a.id account_id,a.identity_id,w.workspace_id
      from tm8_directory.sessions s join tm8_directory.accounts a on a.id=s.account_id
      join tm8_directory.assignments w on w.account_id=a.id where s.id=$1 and w.machine_id=$2
      and s.revoked_at is null and s.expires_at>now() and a.status='active' and w.state<>'suspended'`, [sessionId, machineId]);
    if (!rows[0]) throw new DirectoryError('authorization_revoked', 401);
    return { ...rows[0], leaseSeconds: 30 };
  }

  async logout(sessionSecret) {
    if (sessionSecret) await this.pool.query('update tm8_directory.sessions set revoked_at=now() where secret_hash=$1', [hash(sessionSecret)]);
  }
  async nodeLogout(machineId, credential, sessionId) {
    await this.machine(machineId, credential);
    await this.pool.query(`update tm8_directory.sessions s set revoked_at=now() from tm8_directory.assignments w
      where s.id=$1 and w.account_id=s.account_id and w.machine_id=$2`, [sessionId, machineId]);
    return { ok: true };
  }
  async revokeInvitation(sessionSecret, invitationId) {
    const actor = await this.admin(sessionSecret);
    await this.pool.query('update tm8_directory.invitations set revoked_at=now() where id=$1', [invitationId]);
    await this.audit(actor.id, 'invitation.revoke', invitationId);
    return { ok: true };
  }
  async listMachines(sessionSecret) {
    await this.admin(sessionSecret);
    const { rows } = await this.pool.query(`select id,name,public_origin,provider,capacity,allocated,
      case when state='ready' and last_heartbeat_at < now()-interval '90 seconds' then 'offline' else state end state,
      last_heartbeat_at from tm8_directory.machines order by name,id`);
    return rows;
  }
  async suspend(sessionSecret, accountId) {
    const actor = await this.admin(sessionSecret);
    if (actor.id === accountId) throw new DirectoryError('cannot_suspend_self');
    await this.transaction(async client => {
      await client.query("update tm8_directory.accounts set status='suspended' where id=$1", [accountId]);
      await client.query('update tm8_directory.sessions set revoked_at=now() where account_id=$1 and revoked_at is null', [accountId]);
      await client.query("update tm8_directory.assignments set state='suspended',updated_at=now() where account_id=$1", [accountId]);
    });
    await this.audit(actor.id, 'account.suspend', accountId);
  }
  async assignmentStatus(machineId, credential, workspaceId, state) {
    await this.machine(machineId, credential);
    if (!['provisioning', 'ready', 'failed'].includes(state)) throw new DirectoryError('invalid_state', 400);
    const { rowCount } = await this.pool.query(`update tm8_directory.assignments set state=$3,updated_at=now()
      where workspace_id=$1 and machine_id=$2 and state<>'suspended'`, [workspaceId, machineId, state]);
    if (!rowCount) throw new DirectoryError('assignment_not_found', 404);
  }
  async audit(actorId, action, resourceId) {
    await this.pool.query('insert into tm8_directory.audit(actor_id,action,resource_id) values($1,$2,$3)', [actorId, action, resourceId]);
  }
}

"use client";

import { ActionForm } from "@/components/ActionForm";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, PageHeader } from "@/components/ui";
import { ROLES, ROLE_LABELS, permissionsOf } from "@/lib/domain/roles";
import { fmtDateTime } from "@/lib/format";
import { getUsers } from "@/lib/client/queries";
import { grantAccess, setUserActive, setUserRole } from "@/lib/client/actions";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Account created",
  ROLE_CHANGED: "Role changed",
  ACTIVATED: "Activated",
  DEACTIVATED: "Deactivated",
};

export default function UsersPage() {
  const me = useRequireSession();
  const state = useAsync(() => getUsers(), []);

  if (!me) return null;
  // Reading the staff list at all needs the permission; the rules refuse it
  // otherwise, and `Async` renders that refusal.
  return (
    <Async state={state}>
      {({ users, events }) => (
        <UsersView users={users} events={events} me={me} refresh={state.refresh} />
      )}
    </Async>
  );
}

function UsersView({
  users,
  events,
  me,
  refresh,
}: {
  users: Awaited<ReturnType<typeof getUsers>>["users"];
  events: Awaited<ReturnType<typeof getUsers>>["events"];
  me: SessionUser;
  refresh: () => void;
}) {

  return (
    <>
      <PageHeader
        title="Users and Permissions"
        subtitle="Users and permissions"
      />

      {/* ── what each role may do ── */}
      <Card className="mt-4" title="What each role may do">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-[var(--muted)]">
                <th className="p-2 text-start">Role</th>
                <th className="p-2 text-start">Permissions</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => {
                const permissions = permissionsOf(role);
                return (
                  <tr key={role} className="border-t border-[var(--border)] align-top">
                    <td className="p-2 font-semibold whitespace-nowrap">
                      {ROLE_LABELS[role].en}
                      <div className="ltr text-xs font-normal text-[var(--muted)]">{role}</div>
                    </td>
                    <td className="p-2 text-xs text-[var(--muted)]">
                      {permissions.length === 0 ? (
                        "Reads and reports only. No writes of any kind."
                      ) : (
                        <span className="ltr">{permissions.join(" · ")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── create ── */}
      <Card className="mt-4" title="Create an account">
        <p className="mb-3 text-sm text-[var(--muted)]">
          The name entered here signs every inspection this person records, so write it
          the way it should appear on a report. Hand the password over in person and ask
          them to change it.
        </p>
        <ActionForm action={grantAccess(me)}
              onSuccess={refresh} submitLabel="Create account">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input className="input" name="displayName" required placeholder="Mona Rashad" />
            </div>
            <div>
              <label className="label">Email address</label>
              <input className="input ltr" name="email" type="email" required dir="ltr" />
            </div>
            <div>
              <label className="label">Initial password</label>
              <input
                className="input ltr"
                name="password"
                type="password"
                required
                minLength={8}
                dir="ltr"
              />
            </div>
            <div>
              <label className="label">Employee number (optional)</label>
              <input className="input ltr" name="employeeNo" dir="ltr" />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="select" name="role" defaultValue="INSPECTOR" required>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role].en}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </ActionForm>
      </Card>

      {/* ── the accounts ── */}
      <Card className="mt-4" title={`Accounts (${users.length})`}>
        {users.length === 0 ? (
          <Empty>No accounts.</Empty>
        ) : (
          <ul className="grid gap-2">
            {users.map((user) => {
              const isMe = user.id === me.uid;
              return (
                <li
                  key={user.id}
                  className={`rounded-[var(--radius-sm)] border p-3 ${
                    user.active
                      ? "border-[var(--border)]"
                      : "border-[var(--border)] opacity-60"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-semibold">{user.displayName}</span>
                    {isMe && <span className="pill">You</span>}
                    {!user.active && <span className="pill pill-warn">Deactivated</span>}
                    <span className="ltr text-xs text-[var(--muted)]">{user.email}</span>
                    {user.employeeNo && (
                      <span className="ltr text-xs text-[var(--muted)]">
                        #{user.employeeNo}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {ROLE_LABELS[user.role as (typeof ROLES)[number]]?.en ?? user.role} ·{" "}
                    {user._count.inspections} inspections signed
                    {user.createdBy && ` · created by ${user.createdBy.displayName}`}
                  </div>

                  {isMe ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      You cannot change your own role or deactivate your own account. Another administrator has to.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-end gap-4">
                      <InlineForm action={setUserRole(me)}
              onSuccess={refresh} submitLabel="Change role">
                        <input type="hidden" name="id" value={user.id} />
                        <select className="select" name="role" defaultValue={user.role}>
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role].en}
                            </option>
                          ))}
                        </select>
                      </InlineForm>

                      <InlineForm
                        action={setUserActive(me)}
              onSuccess={refresh}
                        submitLabel={user.active ? "Deactivate" : "Reactivate"}
                        confirm={
                          user.active
                            ? `Deactivate ${user.displayName}? They are refused access immediately, and every inspection they signed stays on the record.`
                            : undefined
                        }
                      >
                        <input type="hidden" name="id" value={user.id} />
                        <input type="hidden" name="active" value={String(!user.active)} />
                      </InlineForm>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ── audit ── */}
      <Card className="mt-4" title="Permission history">
        <p className="mb-3 text-sm text-[var(--muted)]">
          Granting the authority to release product is a decision an audit will ask about, so who changed what, and when, is recorded.
        </p>
        {events.length === 0 ? (
          <Empty>No changes recorded yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)]">
                  <th className="p-2 text-start">Date</th>
                  <th className="p-2 text-start">Action</th>
                  <th className="p-2 text-start">Account</th>
                  <th className="p-2 text-start">From → To</th>
                  <th className="p-2 text-start">By</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-[var(--border)]">
                    <td className="p-2 whitespace-nowrap">{fmtDateTime(event.at)}</td>
                    <td className="p-2">{EVENT_LABELS[event.kind] ?? event.kind}</td>
                    <td className="p-2">{event.subject.displayName}</td>
                    <td className="ltr p-2 text-xs text-[var(--muted)]">
                      {event.fromValue ? `${event.fromValue} → ${event.toValue}` : event.toValue}
                    </td>
                    <td className="p-2">{event.actorUser.displayName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

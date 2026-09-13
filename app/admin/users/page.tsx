"use client";

import { useState } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Async } from "@/components/Async";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty } from "@/components/ui";
import { PlusIcon, UsersIcon } from "@/components/icons";
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,

  can,
  describeOverrides,
  type Permission,
  type Role,
} from "@/lib/domain/roles";
import { fmtDateTime } from "@/lib/format";
import { grantAccess, setUserActive, setUserPermissions, setUserRole } from "@/lib/client/actions";
import { getUsers } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Account created",
  ROLE_CHANGED: "Permissions changed",
  ACTIVATED: "Activated",
  DEACTIVATED: "Deactivated",
};

export default function UsersPage() {
  const me = useRequireSession();
  const state = useAsync(() => getUsers(), []);
  if (!me) return null;

  return (
    <Async state={state}>
      {({ users, events }) => (
        <>
          <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_1fr]">
            <NewAccount me={me} onSaved={state.refresh} />
            <RoleReference />
          </div>

          <Card
            className="rise"
            title={
              <span className="inline-flex items-center gap-2">
                <UsersIcon /> People
              </span>
            }
            action={<span className="pill pill-neutral">{users.length}</span>}
          >
            {users.length === 0 ? (
              <Empty>No accounts.</Empty>
            ) : (
              <div className="grid gap-3">
                {users.map((user) => (
                  <Person key={user.id} user={user} me={me} refresh={state.refresh} />
                ))}
              </div>
            )}
          </Card>

          <Card className="rise mt-4" title="History" subtitle="Who changed what, and when">
            {events.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th>Account</th>
                      <th>To</th>
                      <th>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td className="num whitespace-nowrap">{fmtDateTime(e.at)}</td>
                        <td>{EVENT_LABELS[e.kind] ?? e.kind}</td>
                        <td>{e.subject.displayName}</td>
                        <td className="ltr text-xs">{e.toValue ?? "—"}</td>
                        <td>{e.actorUser.displayName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </Async>
  );
}

/** Adding somebody, without leaving the application.
 *
 *  The sign-in is created from here too — see `lib/client/provision.ts` for
 *  how that is done without a server and without signing the administrator
 *  out. Nobody has to go and find a uid in a console.
 */
function NewAccount({ me, onSaved }: { me: SessionUser; onSaved: () => void }) {
  const [role, setRole] = useState<Role>("INSPECTOR");

  return (
    <Card
      className="rise"
      title={
        <span className="inline-flex items-center gap-2">
          <PlusIcon /> Add somebody
        </span>
      }
      subtitle="Sign-in and access together"
    >
      <ActionForm action={grantAccess(me)} onSuccess={onSaved} submitLabel="Create account">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="displayName">Name</label>
            <input id="displayName" className="input" name="displayName" required placeholder="Hala Fouad" />

          </div>
          <div>
            <label className="label" htmlFor="email">Email address</label>
            <input id="email" className="input ltr" name="email" type="email" required />
          </div>
          <div>
            <label className="label" htmlFor="password">Starting password</label>
            <input id="password" className="input ltr" name="password" type="text" minLength={8} required />

          </div>
          <div>
            <label className="label" htmlFor="employeeNo">Employee number (optional)</label>
            <input id="employeeNo" className="input ltr" name="employeeNo" />
          </div>
        </div>

        <div className="mt-3">
          <label className="label" htmlFor="role">Role</label>
          <select
            id="role"
            className="select"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r].en}</option>
            ))}
          </select>
        </div>

        <PermissionPicker role={role} granted={[]} denied={[]} />
      </ActionForm>
    </Card>
  );
}

/** The role sets the baseline; the ticks move it.
 *
 *  Shown as one list rather than two, because "what may this person do" is one
 *  question. A tick that differs from the role is what gets stored, so an
 *  account left alone carries no exceptions at all — which is what keeps the
 *  list auditable.
 */
function PermissionPicker({
  role,
  granted,
  denied,
}: {
  role: Role;
  granted: readonly Permission[];
  denied: readonly Permission[];
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});

  const isOn = (p: Permission) =>
    ticks[p] ?? (denied.includes(p) ? false : granted.includes(p) ? true : can(role, p));

  return (
    <fieldset className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border)] p-3">
      <legend className="px-1 text-xs font-semibold text-[var(--muted)]">
        What they may do
      </legend>

      <div className="grid gap-1.5">
        {PERMISSIONS.map((p) => {
          const on = isOn(p);
          const fromRole = can(role, p);
          return (
            <label key={p} className="flex min-h-9 items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => setTicks((t) => ({ ...t, [p]: e.target.checked }))}
              />
              <span className={on ? "font-semibold" : "text-[var(--muted)]"}>
                {PERMISSION_LABELS[p]}
              </span>
              {on !== fromRole && (
                <span className={`pill ${on ? "pill-info" : "pill-warn"}`}>
                  {on ? "added" : "removed"}
                </span>
              )}
              {/* Only the difference from the role is stored. An account that
                  matches its role carries no exceptions, which is what keeps
                  this list worth reading. */}
              {on && !fromRole && <input type="hidden" name="granted" value={p} />}
              {!on && fromRole && <input type="hidden" name="denied" value={p} />}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function RoleReference() {
  return (
    <Card className="rise" title="What each role carries" subtitle="Before any exceptions">
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Role</th>
              {PERMISSIONS.map((p) => (
                <th key={p} className="text-center text-[0.65rem] leading-tight">
                  {PERMISSION_LABELS[p].split(" ").slice(0, 2).join(" ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r}>
                <td className="whitespace-nowrap font-semibold">{ROLE_LABELS[r].en}</td>
                {PERMISSIONS.map((p) => (
                  <td key={p} className="text-center">
                    {can(r, p) ? (
                      <span className="text-[var(--ok-fg)]">✓</span>
                    ) : (
                      <span className="text-[var(--muted)]">·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Person({
  user,
  me,
  refresh,
}: {
  user: Awaited<ReturnType<typeof getUsers>>["users"][number];
  me: SessionUser;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const self = user.id === me.uid;
  const role = user.role as Role;
  const overrides = describeOverrides({
    role,
    granted: (user.granted ?? []) as Permission[],
    denied: (user.denied ?? []) as Permission[],
  });

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{user.displayName}</span>
            {self && <span className="pill">You</span>}
            {!user.active && <span className="pill pill-warn">Deactivated</span>}
          </div>
          <div className="text-xs text-[var(--muted)]">
            <span className="ltr">{user.email}</span> · {ROLE_LABELS[role]?.en ?? user.role} ·{" "}
            {user.signedInspections} signed
          </div>
          {overrides.length > 0 && (
            <div className="mt-1 text-xs font-semibold text-[var(--brand)]">
              {overrides.join(" · ")}
            </div>
          )}
        </div>

        {!self && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Permissions"}
            </button>
            <InlineForm
              action={setUserActive(me)}
              onSuccess={refresh}
              submitLabel={user.active ? "Deactivate" : "Reactivate"}
              submitClassName={user.active ? "btn-danger" : ""}
              confirm={
                user.active
                  ? `Deactivate ${user.displayName}? They are refused access immediately, and every inspection they signed stays on the record.`
                  : undefined
              }
            >
              <input type="hidden" name="uid" value={user.id} />
              <input type="hidden" name="active" value={user.active ? "false" : "true"} />
            </InlineForm>
          </div>
        )}
      </div>

      {self && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Somebody else has to change your own permissions.
        </p>
      )}

      {open && !self && (
        <div className="menu-pop mt-3 grid gap-3 border-t border-[var(--border)] pt-3 lg:grid-cols-2">
          <ActionForm action={setUserRole(me)} onSuccess={refresh} submitLabel="Change role">
            <input type="hidden" name="uid" value={user.id} />
            <label className="label" htmlFor={`role-${user.id}`}>Role</label>
            <select id={`role-${user.id}`} className="select" name="role" defaultValue={user.role}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r].en}</option>
              ))}
            </select>
          </ActionForm>

          <ActionForm
            action={setUserPermissions(me)}
            onSuccess={refresh}
            submitLabel="Save permissions"
          >
            <input type="hidden" name="uid" value={user.id} />
            <PermissionPicker
              role={role}
              granted={(user.granted ?? []) as Permission[]}
              denied={(user.denied ?? []) as Permission[]}
            />
          </ActionForm>
        </div>
      )}
    </div>
  );
}

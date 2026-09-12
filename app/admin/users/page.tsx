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
  CREATED: "إنشاء حساب",
  ROLE_CHANGED: "تغيير صلاحية",
  ACTIVATED: "تفعيل",
  DEACTIVATED: "إيقاف",
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
        title="المستخدمون والصلاحيات"
        subtitle="Users and permissions"
      />

      {/* ── what each role may do ── */}
      <Card className="mt-4" title="الصلاحيات لكل دور">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-start text-[var(--muted)]">
                <th className="p-2 text-start">الدور</th>
                <th className="p-2 text-start">ما يستطيع فعله</th>
              </tr>
            </thead>
            <tbody>
              {ROLES.map((role) => {
                const permissions = permissionsOf(role);
                return (
                  <tr key={role} className="border-t border-[var(--border)] align-top">
                    <td className="p-2 font-semibold whitespace-nowrap">
                      {ROLE_LABELS[role].ar}
                      <div className="ltr text-xs font-normal text-[var(--muted)]">{role}</div>
                    </td>
                    <td className="p-2 text-xs text-[var(--muted)]">
                      {permissions.length === 0 ? (
                        "الاطّلاع والتقارير فقط — بدون أي كتابة."
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
      <Card className="mt-4" title="إنشاء حساب جديد">
        <p className="mb-3 text-sm text-[var(--muted)]">
          الاسم المكتوب هنا هو الاسم الذي سيُوقَّع به على كل فحص، فاكتبه كما يجب أن يظهر في
          التقارير. سلّم كلمة المرور للموظف واطلب منه تغييرها.
        </p>
        <ActionForm action={grantAccess(me)}
              onSuccess={refresh} submitLabel="إنشاء الحساب">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">الاسم</label>
              <input className="input" name="displayName" required placeholder="م. منى رشاد" />
            </div>
            <div>
              <label className="label">البريد الإلكتروني</label>
              <input className="input ltr" name="email" type="email" required dir="ltr" />
            </div>
            <div>
              <label className="label">كلمة المرور المبدئية</label>
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
              <label className="label">الرقم الوظيفي (اختياري)</label>
              <input className="input ltr" name="employeeNo" dir="ltr" />
            </div>
            <div>
              <label className="label">الصلاحية</label>
              <select className="select" name="role" defaultValue="INSPECTOR" required>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role].ar}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </ActionForm>
      </Card>

      {/* ── the accounts ── */}
      <Card className="mt-4" title={`الحسابات (${users.length})`}>
        {users.length === 0 ? (
          <Empty>لا توجد حسابات.</Empty>
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
                    {isMe && <span className="pill">أنت</span>}
                    {!user.active && <span className="pill pill-warn">موقوف</span>}
                    <span className="ltr text-xs text-[var(--muted)]">{user.email}</span>
                    {user.employeeNo && (
                      <span className="ltr text-xs text-[var(--muted)]">
                        #{user.employeeNo}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {ROLE_LABELS[user.role as (typeof ROLES)[number]]?.ar ?? user.role} ·{" "}
                    {user._count.inspections} فحص موقَّع
                    {user.createdBy && ` · أنشأه ${user.createdBy.displayName}`}
                  </div>

                  {isMe ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      لا يمكنك تغيير صلاحيتك أو إيقاف حسابك بنفسك. يقوم بذلك مدير نظام آخر.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-end gap-4">
                      <InlineForm action={setUserRole(me)}
              onSuccess={refresh} submitLabel="تغيير الصلاحية">
                        <input type="hidden" name="id" value={user.id} />
                        <select className="select" name="role" defaultValue={user.role}>
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role].ar}
                            </option>
                          ))}
                        </select>
                      </InlineForm>

                      <InlineForm
                        action={setUserActive(me)}
              onSuccess={refresh}
                        submitLabel={user.active ? "إيقاف الحساب" : "إعادة التفعيل"}
                        confirm={
                          user.active
                            ? `إيقاف حساب ${user.displayName}؟ سيُمنع من الدخول فورًا، وتبقى كل فحوصه في السجل.`
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
      <Card className="mt-4" title="سجل تغييرات الصلاحيات">
        <p className="mb-3 text-sm text-[var(--muted)]">
          منح صلاحية الإفراج النهائي قرار يُسأل عنه في التدقيق، فيُسجَّل من غيّر ماذا ومتى.
        </p>
        {events.length === 0 ? (
          <Empty>لا توجد تغييرات مسجَّلة بعد.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--muted)]">
                  <th className="p-2 text-start">التاريخ</th>
                  <th className="p-2 text-start">الإجراء</th>
                  <th className="p-2 text-start">الحساب</th>
                  <th className="p-2 text-start">من ← إلى</th>
                  <th className="p-2 text-start">بواسطة</th>
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

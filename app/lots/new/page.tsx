"use client";

import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { receiveLot } from "@/lib/client/actions";
import { todayInputValue } from "@/lib/format";
import { getMaterials, getSuppliers } from "@/lib/client/queries";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

export default function NewLotPage() {
  const user = useRequireSession();
  const state = useAsync(
    async () => ({
      materials: await getMaterials(),
      suppliers: await getSuppliers(),
    }),
    []
  );

  if (!user) return null;
  return (
    <Async state={state}>
      {({ materials, suppliers }) => (
        <NewLotView materials={materials} suppliers={suppliers} user={user} />
      )}
    </Async>
  );
}

function NewLotView({
  materials,
  suppliers,
  user,
}: {
  materials: Awaited<ReturnType<typeof getMaterials>>;
  suppliers: Awaited<ReturnType<typeof getSuppliers>>;
  user: SessionUser;
}) {
  const today = todayInputValue();

  return (
    <>
      <PageHeader
        title="Receive Material"
        subtitle="Step 1 — the delivery. The inspection sheet is filled in after saving."
      />

      {materials.length === 0 ? (
        <Card>
          <Empty>
            At least one specification (part number) has to exist first.{" "}
            <Link href="/materials" className="font-bold text-[var(--brand)]">
              Go to specifications
            </Link>
            .
          </Empty>
        </Card>
      ) : (
        <Card className="max-w-3xl">
          <ActionForm action={receiveLot(user)} submitLabel="Save and open the inspection sheet">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Lot number">
                <input className="input ltr" name="lotNumber" required placeholder="LOT-2026-001" />
              </Field>

              <Field label="Material / part number">
                <select className="select" name="materialId" required defaultValue="">
                  <option value="" disabled>
                    — Choose —
                  </option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.partNumber}
                      {m.spec ? ` — ${m.spec}` : ""}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Supplier">
                <select className="select" name="supplierId" defaultValue="">
                  <option value="">— Not specified —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Date received">
                <input className="input num" name="receivedAt" type="date" defaultValue={today} />
              </Field>

              <Field label="Quantity received">
                <input
                  className="input num"
                  name="receivedQty"
                  type="number"
                  step="0.001"
                  min="0.001"
                  required
                />
              </Field>

              <Field label="Unit">
                <select className="select" name="unit" defaultValue="pcs">
                  <option value="pcs">Pieces (pcs)</option>
                  <option value="kg">Kilograms (kg)</option>
                  <option value="m">Metres (m)</option>
                </select>
              </Field>

              <Field label="Purchase order">
                <input className="input ltr" name="poNumber" />
              </Field>

              <Field label="Heat number" hint="From the mill certificate">
                <input className="input ltr" name="heatNumber" />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Notes">
                <textarea className="textarea" name="notes" rows={2} />
              </Field>
            </div>

            <p className="mt-3 text-xs text-[var(--muted)]">
              The certificates the specification requires are added automatically, each awaiting receipt.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  );
}

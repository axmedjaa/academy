"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createIncomeRecord as createIncomeRecordForActor,
  type CreateIncomeRecordInput,
  type IncomeRecordActionError,
} from "@/lib/academies/income-records";

/**
 * PLAN.md Phase 4, Item 53's income server action — thin `"use server"`
 * wrapper, same convention as lib/academies/student-payments-actions.ts.
 * There is deliberately no submit/approve/reject action here — see
 * lib/academies/income-records.ts's module comment for why.
 */
const UNAUTHENTICATED: IncomeRecordActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface IncomeRecordFormState {
  ok: boolean;
  error?: IncomeRecordActionError;
}

function parseCreateIncomeRecordFormData(formData: FormData): CreateIncomeRecordInput {
  const branchId = String(formData.get("branchId") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  return {
    branchId: branchId.length > 0 ? branchId : undefined,
    category: String(formData.get("category") ?? ""),
    description: description.length > 0 ? description : undefined,
    amountCents: Number(formData.get("amountCents") ?? 0),
    currency: currency.length > 0 ? currency : undefined,
  };
}

export async function createIncomeRecordAction(
  _prevState: IncomeRecordFormState,
  formData: FormData,
): Promise<IncomeRecordFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await createIncomeRecordForActor(context, parseCreateIncomeRecordFormData(formData));
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/finance");
  return { ok: true };
}

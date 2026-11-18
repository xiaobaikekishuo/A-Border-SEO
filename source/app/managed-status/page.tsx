import { getI18n } from "@/lib/i18n/server";
import { managedDecision } from "@/lib/managed/policy";
import Link from "next/link";
import { currentHostedPolicy, hostedMode } from "@/lib/hosted/access";

export const dynamic = "force-dynamic";

const descriptions: Record<string, [string, string]> = {
  hosted_verification_unavailable: ["The server could not verify this device. Try again shortly.", "服务器暂时无法验证此设备，请稍后重试。"],
  policy_denied: ["Workspace access is paused by your administrator.", "管理员已暂停工作台访问。"],
  maintenance: ["The workspace is in maintenance.", "工作台正在维护。"],
  product_disabled: ["The product is temporarily disabled.", "该产品已暂停使用。"],
  account_disabled: ["The management account is disabled.", "管理账号已停用。"],
  device_disabled: ["This device is disabled.", "此设备已停用。"],
  update_required: ["Update both desktop and backend to continue.", "请更新桌面程序和后台后继续。"],
  entitlement_expired: ["The account authorization has expired.", "账号授权已到期。"],
};

export default async function ManagedStatus() {
  const { t } = await getI18n();
  const decision = hostedMode() ? (await currentHostedPolicy().catch(() => ({
    allowed: false, reason: "hosted_verification_unavailable", maintenanceMessage: "",
  })) ?? { allowed: false, reason: "verification_required", maintenanceMessage: "" }) : managedDecision();
  const message = decision.allowed
    ? ["The workspace is available.", "工作台可用。"]
    : descriptions[decision.reason ?? ""] ?? ["Connect the desktop app to verify this device.", "请打开桌面控制台联网验证此设备。"];
  return <main className="mx-auto max-w-xl space-y-4 px-6 py-16">
    <h1 className="text-2xl font-semibold">A-Border SEO</h1>
    <p>{t(message[0], message[1])}</p>
    {decision.maintenanceMessage && <p>{decision.maintenanceMessage}</p>}
    <p>{t("Open the desktop control panel for authorization, updates and backups.", "可在桌面控制台查看授权、更新和备份。")}</p>
    {decision.allowed && <Link href="/" className="underline">{t("Open workspace", "打开工作台")}</Link>}
  </main>;
}

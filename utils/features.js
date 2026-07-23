"use strict";
//
// Feature catalog — the single source of truth for per-user access.
//
// A "feature" key mirrors the web app's nav path (e.g. "/orders"). A
// user's `User.features` array lists the features they may open. This
// stays in sync with prod_web/src/app/navigation.ts — adding a nav item
// there means adding it here too.
//
// `depts: "all"` marks a feature every authenticated user can open (it is
// never gated). Otherwise `depts` lists the departments whose DEFAULT set
// includes the feature — used only to backfill features for a user who
// has none yet (legacy users, or a create that didn't pass an explicit
// list). Actual access is always driven by `User.features`.

const FEATURES = [
  { key: "/",                    label: "Dashboard",           section: "Overview",       depts: "all" },
  { key: "/analytics",           label: "Analytics",           section: "Overview",       depts: ["admin", "weaving"] },
  { key: "/reports",             label: "Reports",             section: "Overview",       depts: ["admin", "finance"] },
  { key: "/audit",               label: "Audit Trail",         section: "Overview",       depts: ["admin"] },

  { key: "/orders",              label: "Orders",              section: "Sales",          depts: ["admin", "finance"] },
  { key: "/jobs",                label: "Job Orders",          section: "Sales",          depts: ["admin", "preparatory", "weaving", "packing"] },
  { key: "/delivery-challans",   label: "Delivery Challans",   section: "Sales",          depts: ["admin", "finance"] },

  { key: "/planner",             label: "Auto Planner",        section: "Production",     depts: ["admin", "weaving"] },
  { key: "/warping",             label: "Warping",             section: "Production",     depts: ["admin", "preparatory"] },
  { key: "/covering",            label: "Covering",            section: "Production",     depts: ["admin", "preparatory"] },
  { key: "/packing",             label: "Packing",             section: "Production",     depts: ["admin", "packing"] },
  { key: "/qc",                  label: "Quality Control",     section: "Production",     depts: ["admin", "packing"] },
  { key: "/shift-plans",         label: "Shift Plans",         section: "Production",     depts: ["admin", "weaving"] },
  { key: "/shift-verification",  label: "Shift Verification",  section: "Production",     depts: ["admin", "weaving"] },
  { key: "/production",          label: "Production View",     section: "Production",     depts: ["admin", "weaving"] },
  { key: "/wastage",             label: "Wastage",             section: "Production",     depts: ["admin", "weaving"] },

  { key: "/customers",           label: "Customers",           section: "Masters",        depts: ["admin", "finance"] },
  { key: "/suppliers",           label: "Suppliers",           section: "Masters",        depts: ["admin", "finance"] },
  { key: "/purchase-orders",     label: "Purchase Orders",     section: "Masters",        depts: ["admin", "finance"] },
  { key: "/materials",           label: "Raw Materials",       section: "Masters",        depts: ["admin", "finance"] },
  { key: "/elastics",            label: "Elastic Products",    section: "Masters",        depts: ["admin", "finance"] },
  { key: "/elastic-groups",      label: "Elastic Groups",      section: "Masters",        depts: ["admin"] },
  { key: "/machines",            label: "Machines",            section: "Masters",        depts: ["admin", "weaving"] },
  { key: "/employees",           label: "Employees",           section: "Masters",        depts: ["admin", "finance"] },

  { key: "/attendance",          label: "Attendance",          section: "HR & Payroll",   depts: ["admin", "finance"] },
  { key: "/payroll",             label: "Payroll",             section: "HR & Payroll",   depts: ["admin", "finance"] },
  { key: "/bonus",               label: "Bonus",               section: "HR & Payroll",   depts: ["admin", "finance"] },
  { key: "/leave",               label: "Leave",               section: "HR & Payroll",   depts: ["admin", "finance"] },

  { key: "/announcements",       label: "Announcements",       section: "Communication",  depts: "all" },
  { key: "/feedback",            label: "Feedback",            section: "Communication",  depts: "all" },
  { key: "/machine-issues",      label: "Machine Issues",      section: "Communication",  depts: "all" },
  { key: "/notification-settings", label: "Notifications",     section: "Communication",  depts: ["admin"] },

  { key: "/advisor",             label: "AI Advisor",          section: "AI",             depts: ["admin", "finance"] },
  { key: "/assistant",           label: "Ask Jarvis",          section: "AI",             depts: "all" },

  { key: "/users",               label: "Users",               section: "Administration", depts: ["admin"] },
  { key: "/data-io",             label: "Data Import/Export",  section: "Administration", depts: ["admin"] },
  { key: "/settings",            label: "Settings",            section: "Administration", depts: "all" },
];

const FEATURE_KEYS = FEATURES.map((f) => f.key);
const FEATURE_KEY_SET = new Set(FEATURE_KEYS);
const ALWAYS_ON = FEATURES.filter((f) => f.depts === "all").map((f) => f.key);

const FLOOR_DEPTS = ["preparatory", "weaving", "packing"];

// Default feature set for a department/role — used to backfill users who
// have no explicit list yet. Admin gets everything.
function featuresForDepartment(department) {
  if (department === "admin") return [...FEATURE_KEYS];
  const match = (f) => {
    if (f.depts === "all") return true;
    if (department === "production") return f.depts.some((d) => FLOOR_DEPTS.includes(d));
    return !!department && f.depts.includes(department);
  };
  return FEATURES.filter(match).map((f) => f.key);
}

// Keep only real feature keys (drops anything unknown a client sends).
function sanitizeFeatures(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.filter((k) => FEATURE_KEY_SET.has(k)))];
}

module.exports = {
  FEATURES,
  FEATURE_KEYS,
  ALWAYS_ON,
  featuresForDepartment,
  sanitizeFeatures,
};

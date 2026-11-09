import { describe, expect, it } from "vitest";
import { type CurrentUser, can, PERMISSIONS, type Permission, ROLES, type Role } from "@/server/auth/permissions";

const userOf = (role: Role): CurrentUser => ({ id: `u-${role}`, name: role, roles: [role] });

// 権限表（仕様書の「権限表」と同じもの）。○ = できる、× = できない
const TABLE: Record<Permission, Record<Role, boolean>> = {
  "todos.read": { admin: true, member: true, viewer: true },
  "todos.create": { admin: true, member: true, viewer: false },
};

describe("can（権限表）", () => {
  for (const permission of Object.keys(TABLE) as Permission[]) {
    for (const role of ROLES) {
      const expected = TABLE[permission][role];
      it(`${role} は ${permission} が${expected ? "できる" : "できない"}`, () => {
        expect(can(userOf(role), permission)).toBe(expected);
      });
    }
  }

  it("表のすべての権限をテストしている", () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  it("ログインしていなければ何もできない", () => {
    expect(can(null, "todos.read")).toBe(false);
  });

  it("役割を複数持つ利用者は、どれか1つでできればできる", () => {
    expect(can({ id: "u", name: "u", roles: ["viewer", "member"] }, "todos.create")).toBe(true);
  });
});

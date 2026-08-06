/**
 * The repository barrel.
 *
 * This is what the poison-row suite reflects over. Every exported function is
 * enumerated, invoked as a foreign principal, and asserted to return and mutate
 * nothing — which means a repository function written next year is covered
 * without anyone remembering to write a test for it.
 *
 * That property only holds if functions are exported *from here*. A repository
 * module that is not re-exported is invisible to the suite, so the barrel
 * completeness check in `../test/poison-rows.test.ts` asserts that every
 * `repositories/*.ts` module is represented.
 */

export * as projects from "./projects.js";
export * as issues from "./issues.js";
export * as members from "./members.js";

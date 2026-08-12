/*
 * Agents — the programs people hold a conversation with in a tab.
 *
 * A shell that dies takes what was running in it, and clio is careful not to
 * guess at bringing that back: a command is named in the seam and left for the
 * user to run again. An agent is different in kind. The work is not the
 * process, it is the conversation the process was showing; the conversation is
 * on disk the whole time, and picking it up again runs nothing that was not
 * already run.
 *
 * So this is one of the two things clio will start for you — see ../ssh for the
 * other, which earns it a different way — and this directory is where the
 * knowledge of which programs those are lives. It knows nothing about clio: the
 * host in ../extensions hands an adapter a description of a process and gets
 * plain data back, and no adapter ever executes anything.
 *
 * See ../extensions/README.md for the contract, and README.md here for what
 * makes something an agent.
 */

import claude from './claude.js';

export default [claude];

import { cli } from '@silkweave/cli'
import { silkweave } from '@silkweave/core'
import { actions } from './actions/index.js'
import { SetupStatus } from './actions/Setup/SetupStatus.js'
import { SetupSubscribeAll } from './actions/Setup/SetupSubscribeAll.js'
import { VERSION } from './lib/version.js'

const cliOnlyActions = [SetupStatus, SetupSubscribeAll]

async function main() {
  await silkweave({ name: 'silkweave-meet', description: 'Meet MCP', version: VERSION })
    .adapter(cli())
    .actions([...actions, ...cliOnlyActions])
    .start()
}

main()

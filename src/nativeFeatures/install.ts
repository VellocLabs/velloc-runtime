/** Installs the built-in native hooks into this realm (F-26). Imported for its effect. */
import { installNativeHooks } from '../toolkit/nativeHooks'
import { buildNativeHooks } from './index'

installNativeHooks(buildNativeHooks())

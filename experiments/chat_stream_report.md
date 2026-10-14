# Grounded chat state tools and real SSE regression

normal origin2017-10-23T14:00:00-05:00. Previously unknown fourqueries now read selectedreason/handoff/receipt/currentstate from exportedoriginrow, without getting unrelatedfuturepath. Origin-local today/nextdaylabels. CurrentSOC50%,temperature13.3C,setpoint25.5C; nohandoff atcurrentorigin; receipt2logcommands not connectedphysicalequipment. All numbers have dedicated numerictoolleaves, summariesnot assumedproof ofcontrolsavings. Selectioncost/peak reference2hwindow; temperature/SOCcurrentorigin. Unknownfactsstillunknown.

SSE firstplan beforeJSONexport/config/network. Toolstart/end at actualhostexecution. Badgrounding emitscorrectivestep beforeanyanswer_delta. Answersbufferedforgrounding, then validatedchunks, no rawprovidertextleak. /chat sameJSONshape, sharedpipeline.13sdeadline, bounded4concurrentdaemonworkers;4sselection/6sanswer/remainingrewrite. Workers timedoutmaycontinueuntilHTTPtransporttimeout, cannotemitanswer or logbody, semaphoreprevents unboundedspawn. Not a hardOSdeadlineonCPU/exportparsing, no guaranteedallnetworklatency, but observedbelow15s. Providerfailuremetadataonly. Existing8000serviceuntouched; managedtest8001stoppedfinally.

Final realconfiguration regression12requests (6JSON+6SSE), assertions: firstevent<1s, step→tool_start→tool_end→answer_delta→done, exactdonefieldnames, currentknown/handoffcorrect, allgrounded, totals<15s. Requestbodies/answers/keynotlogged. JSON3actualLLManswers and3rulefallbacks; streammodecannot be inferred fromdone(no newfieldsadded). Evenrealconfig requests maytimeout and fallback, not reportedasallLLMsuccess. what-if target26C includesfuturegate refusal, hence known=false/needs_human=true, no fabricated24hcost.

|case|questiontype|SSEfirstms|SSEtotalms|JSONtotalms|known|needs_human|grounded|JSONsource|
|---|---|---:|---:|---:|---|---|---|---|
|1|selectionreason|16|8172|7375|true|false|true|ruledeadline|
|2|handoffreason|0|4344|5156|true|false|true|realLLM|
|3|receipt|15|6312|6063|true|false|true|realLLM|
|4|SOC/state|0|9781|4047|true|false|true|ruledeadline|
|5|24hpeak|31|8516|4125|true|false|true|realLLM|
|6|HVACwhat-if|31|4078|4047|false|true|true|ruledeadline|

Tests: stateprecision/date/peakscope/currenthandoff, two-costtoolwhatif, groundedrequiredvalues/correctivesteps, secret-safeproviderfailure, boundedwait, exactSSEwire/error/doneordering, offline/noenv and real-configtransportregression.113pytestpass(Starlettedeprecationwarningonly). No forecasts/replayexports/models changedthisrequest. Frontendconsumption/8000existingprocessreload separate; backenddoesnot touch twin.

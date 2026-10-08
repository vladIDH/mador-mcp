# mador-mcp

**Estratto dal server MCP che fa girare [Mador](https://mador.ai) in produzione, come pacchetto TypeScript riusabile.**

Un server [Model Context Protocol](https://modelcontextprotocol.io) in sola lettura per qualsiasi SaaS: i tuoi utenti collegano il tuo prodotto a Claude o a ChatGPT e chiedono «come sta andando il mio account?».

- **Sola lettura**: ogni strumento si dichiara con `defineReadOnlyTool()`, che manda sempre le annotazioni di sola lettura.
- **Un utente per richiesta**: il token si controlla a ogni richiesta e il server si costruisce attorno a quell'utente. Gli strumenti non ricevono mai un id utente fra gli argomenti.
- **Un limite di tempo per ogni chiamata** (10 secondi di default): un database lento diventa un errore leggibile, non una funzione uccisa dalla piattaforma.
- **Nessun flusso tenuto aperto**: il server dichiara `tools.listChanged: false` (la lezione dei timeout a 300 secondi, spiegata nel README inglese).
- **Limite di chiamate per utente** (60 al minuto di default) ed **errori puliti**: al modello non arrivano mai nomi di tabelle o dettagli interni.

## Provarlo

```bash
git clone https://github.com/vladIDH/mador-mcp.git
cd mador-mcp
npm install
npm test
npm run demo    # server di prova su http://localhost:3333/mcp, con dati finti
```

All'avvio il demo stampa un token per ciascuno dei due utenti di prova. Si prova con l'MCP Inspector (`npx @modelcontextprotocol/inspector`), trasporto «Streamable HTTP», intestazione `Authorization: Bearer <token>`.

## Collegarlo

- **Token statici per utente**: funzionano con Claude Code, Cursor, MCP Inspector e il connettore MCP dell'API di Claude.
- **Claude.ai e ChatGPT** accettano solo OAuth: questo pacchetto controlla i token, e li rilascia un server di autorizzazione esterno (Auth0, WorkOS, Clerk, Supabase Auth…). Configurazione, requisiti e passi per Claude e ChatGPT sono nel [README inglese](README.md#authentication).

## Licenza

[MIT](LICENSE). Dal team di [Mador](https://mador.ai).

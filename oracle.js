import "dotenv/config";
import Web3 from "web3";
import fs from "fs";
import retry from "async-retry";
import leagueAbi from "./FantasyLeagueABI.json" with { type: "json" };

function env(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Falta ${name} en .env`);
    return v;
}

// ── Web3 y contrato ─────────────────────────────────────
const web3 = new Web3(env("RPC_URL"));
const acct = web3.eth.accounts.privateKeyToAccount(env("ORACLE_PRIVATE_KEY"));
web3.eth.accounts.wallet.add(acct);

const league = new web3.eth.Contract(leagueAbi, env("LEAGUE_ADDRESS"));

// ── Parámetros ───────────────────────────────────────────
const GAS_LIMIT = 120_000;           // cabe de sobra con uint32
const STATS_FILE = "./stats.json";

// ── Utilidades ───────────────────────────────────────────
function loadStats() {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
}

/** Empaca un jugador en un uint32 (ver tabla de bits) */
function pack32(p) {
    // validaciones *hard*; lanza si algo sobrepasa los límites
    if (p.goles > 8) throw new Error(`goles>8 id=${p.id}`);
    if (p.asistencias > 8) throw new Error(`asis>8 id=${p.id}`);
    if (p.penaltisParados > 4) throw new Error(`penaltisParados>4 id=${p.id}`);
    if (p.paradas > 32 ||
        p.despejes > 64) throw new Error(`paradas/despejes fuera de rango id=${p.id}`);
    if (p.minutosJugados > 90) throw new Error(`minutos>90 id=${p.id}`);
    if (p.tarjetasAmarillas > 2 || p.tarjetasRojas > 1)
        throw new Error(`tarjetas fuera de rango id=${p.id}`);

    const paradas = Math.min(p.paradas, 31);            // 5 bits
    const despejes = Math.min(p.despejes, 63);           // 6 bits
    const minutosQ = Math.floor(p.minutosJugados / 3);   // 0-30, 5 bits

    let d = BigInt(p.goles & 0x0F);        // 4 bits
    d |= BigInt(p.asistencias & 0x0F) << 4n;         // +4 = 8
    d |= BigInt(paradas & 0x1F) << 8n;         // +5 = 13
    d |= BigInt(p.penaltisParados & 0x07) << 13n;        // +3 = 16
    d |= BigInt(despejes & 0x3F) << 16n;        // +6 = 22
    d |= BigInt(minutosQ & 0x1F) << 22n;        // +5 = 27
    d |= BigInt(p.tarjetasAmarillas & 0x03) << 27n;        // +2 = 29
    d |= BigInt(p.tarjetasRojas & 0x01) << 29n;        // +1 = 30
    if (p.porteriaCero) d |= 1n << 30n;
    if (p.ganoPartido) d |= 1n << 31n;

    return "0x" + d.toString(16).padStart(8, "0");        // 8-byte hex
}

// ── Métricas (opcional) ─────────────────────────────────
let totalGas = 0n, latencies = [];

// ── Envío de una estadística ────────────────────────────
async function sendPacked(packedHex, id, nonce) {
    const tx = league.methods.actualizarStatsPacked32(id, packedHex);
    const encoded = tx.encodeABI();

    const block = await web3.eth.getBlock("pending");
    const base = BigInt(block.baseFeePerGas);
    const tip = 2n * 10n ** 9n;
    const maxFee = base * 2n + tip;

    const txData = {
        from: acct.address,
        to: league.options.address,
        gas: GAS_LIMIT,
        maxPriorityFeePerGas: tip.toString(),
        maxFeePerGas: maxFee.toString(),
        nonce,
        data: encoded
    };

    return retry(async () => {
        const t0 = Date.now();
        const signed = await acct.signTransaction(txData);
        const rcpt = await web3.eth.sendSignedTransaction(signed.rawTransaction);
        const dt = Date.now() - t0;

        totalGas += BigInt(rcpt.gasUsed);
        latencies.push(dt);

        console.log(`id ${id}  gas=${rcpt.gasUsed}  ${dt} ms`);
        return rcpt;
    }, { retries: 3, onRetry: (e, i) => console.log(`reintento id ${id} (${i})`) });
}

// ── Main ────────────────────────────────────────────────
(async () => {
    const stats = loadStats();
    let nonce = await web3.eth.getTransactionCount(acct.address, "pending");

    console.time("batch");
    for (const p of stats) {
        if (p.goles === undefined) continue;    // ignora filas incompletas
        const packed = pack32(p);
        await sendPacked(packed, p.id, nonce++);
    }
    console.timeEnd("batch");

    const avgGas = Number(totalGas) / stats.length;
    const avgLat = latencies.reduce((a, b) => a + b, 0) / stats.length;

    console.log("\n── Resumen ─────────│");
    console.log(`Jugadores procesados : ${stats.length}`);
    console.log(`Gas total            : ${totalGas}`);
    console.log(`Gas medio / jugador  : ${avgGas.toFixed(0)}`);
    console.log(`Latencia media (ms)  : ${avgLat.toFixed(0)}`);
    process.exit(0);
})();

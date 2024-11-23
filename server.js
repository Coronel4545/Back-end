const express = require('express');
const Web3 = require('web3');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

const app = express();

// Configuração do CORS para permitir o domínio do Netlify
app.use(cors({
    origin: ['https://front-endrampayment.netlify.app'],
    methods: ['GET', 'POST'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use(express.json());

// Verifica se a variável de ambiente existe
const WSS_ENDPOINT = process.env.BSC_TESTNET_WSS || 'wss://bsc-testnet.publicnode.com';

// Função para criar conexão WebSocket com retry
function createWeb3WSProvider() {
    console.log('Tentando conectar ao endpoint:', WSS_ENDPOINT); // Log para debug

    if (!WSS_ENDPOINT) {
        throw new Error('BSC_TESTNET_WSS não está definido');
    }

    const provider = new Web3.providers.WebsocketProvider(WSS_ENDPOINT, {
        reconnect: {
            auto: true,
            delay: 5000,
            maxAttempts: 5,
            onTimeout: false
        }
    });

    provider.on('connect', () => {
        console.log('🟢 WebSocket conectado à BSC Testnet');
    });

    provider.on('error', (error) => {
        console.error('🔴 Erro na conexão WebSocket:', error);
    });

    provider.on('end', () => {
        console.log('🟡 Conexão WebSocket finalizada. Tentando reconectar...');
    });

    return provider;
}

const web3 = new Web3(createWeb3WSProvider());

// ABI do contrato de processamento
const CONTRACT_ABI = [
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "payer",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "PaymentReceived",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "address",
                "name": "user",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "string",
                "name": "url",
                "type": "string"
            }
        ],
        "name": "WebsiteUrlReturned",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "processPayment",
        "outputs": [{"internalType": "string","name": "","type": "string"}],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// Endereço do contrato
const CONTRACT_ADDRESS = '0xa7f84DBD569C7FE49B9F6486EFd4CD5223645b39';

// Inicializa o contrato
const contract = new web3.eth.Contract(
    CONTRACT_ABI,
    CONTRACT_ADDRESS
);

// Adiciona timestamp de última conexão ao schema
const urlEventSchema = new mongoose.Schema({
    userAddress: String,
    url: String,
    transactionHash: String,
    timestamp: { type: Date, default: Date.now },
    processedAt: { type: Date, default: Date.now }
});

const UrlEvent = mongoose.model('UrlEvent', urlEventSchema);

// Monitor de status do MongoDB
mongoose.connection.on('connected', () => {
    console.log('📦 MongoDB conectado com sucesso');
});

mongoose.connection.on('error', (err) => {
    console.error('❌ Erro na conexão MongoDB:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('🔌 MongoDB desconectado');
});

// Conecta ao MongoDB com logs melhorados
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('🚀 Sistema inicializado e pronto para processar eventos'))
    .catch(err => console.error('💥 Falha na inicialização:', err));

// Monitor de eventos aprimorado
function startEventListener() {
    console.log('👀 Iniciando monitoramento de eventos...');
    
    contract.events.WebsiteUrlReturned({
        fromBlock: 'latest'
    })
    .on('connected', (subscriptionId) => {
        console.log('🎯 Listener conectado com ID:', subscriptionId);
    })
    .on('data', async (event) => {
        console.log('📨 Novo evento recebido - URL:', event.returnValues.url);

        try {
            const urlEvent = new UrlEvent({
                userAddress: event.returnValues.user,
                url: event.returnValues.url,
                transactionHash: event.transactionHash
            });
            await urlEvent.save();
            console.log('💾 Evento salvo com sucesso:', {
                transactionHash: event.transactionHash,
                url: event.returnValues.url
            });
        } catch (error) {
            console.error('❌ Erro ao salvar evento:', error);
        }
    })
    .on('changed', (event) => {
        console.log('🔄 Evento modificado (reorg):', event);
    })
    .on('error', (error) => {
        console.error('💥 Erro no listener de eventos:', error);
        console.log('🔄 Reiniciando listener em 5 segundos...');
        setTimeout(startEventListener, 5000);
    });
}

// Rota de API aprimorada
app.post('/api/get-website', async (req, res) => {
    const startTime = Date.now();
    const { transactionHash } = req.body;
    
    console.log('📥 Requisição recebida para hash:', transactionHash);
    
    try {
        let attempts = 0;
        const maxAttempts = 30;
        
        const checkUrl = async () => {
            const event = await UrlEvent.findOne({ transactionHash });
            
            if (event) {
                const processTime = Date.now() - startTime;
                console.log('✅ URL encontrada e enviada:', {
                    transactionHash,
                    url: event.url,
                    processTime: `${processTime}ms`
                });
                return res.json({ 
                    url: event.url,
                    processTime,
                    timestamp: event.timestamp 
                });
            }
            
            attempts++;
            console.log(`⏳ Tentativa ${attempts}/${maxAttempts} para hash:`, transactionHash);
            
            if (attempts >= maxAttempts) {
                console.log('⚠️ Timeout na busca da URL:', transactionHash);
                return res.status(404).json({ 
                    error: 'URL não encontrada',
                    attempts,
                    processTime: Date.now() - startTime
                });
            }
            
            setTimeout(checkUrl, 1000);
        };
        
        checkUrl();
    } catch (error) {
        console.error('💥 Erro ao processar requisição:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rota de health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        mongoStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        web3Status: web3.currentProvider.connected ? 'connected' : 'disconnected'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    startEventListener();
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (error) => {
    console.error('🔥 Erro não tratado:', error);
});

process.on('SIGTERM', async () => {
    console.log('📴 Recebido sinal SIGTERM, encerrando graciosamente...');
    try {
        await mongoose.connection.close();
        console.log('🔌 MongoDB desconectado através de encerramento do app');
        process.exit(0);
    } catch (err) {
        console.error('Erro ao fechar conexão:', err);
        process.exit(1);
    }
});

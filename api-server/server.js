const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const axios = require('axios');
const EventEmitter = require('events');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));

// OpenAI API 호출 함수
async function callOpenAI(messages, temperature = 0.7) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4",
            messages: messages,
            temperature: temperature
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API 오류:', error.response?.data || error.message);
        throw new Error('OpenAI API 호출 실패');
    }
}

// 범용 MCP 클라이언트 클래스
class MCPClient extends EventEmitter {
    constructor(serverName, serverPath, serverCommand = 'python') {
        super();
        this.serverName = serverName;
        this.serverPath = serverPath;
        this.serverCommand = serverCommand;
        this.process = null;
        this.requestId = 1;
        this.isInitialized = false;
        this.pendingRequests = new Map();
        this.messageBuffer = '';
    }

    async initialize() {
        if (this.isInitialized && this.process && !this.process.killed) {
            console.log(`✅ ${this.serverName} MCP 클라이언트 이미 초기화됨`);
            return true;
        }

        console.log(`🔄 ${this.serverName} MCP 클라이언트 초기화 시작...`);

        return new Promise((resolve, reject) => {
            if (this.process) {
                this.process.kill();
            }

            // 서버 명령 구성
            let spawnCommand, spawnArgs;

            if (this.serverCommand === 'python') {
                spawnCommand = 'python';
                spawnArgs = [this.serverPath, '--transport', 'stdio'];
            } else if (this.serverCommand === 'node') {
                spawnCommand = 'node';
                spawnArgs = [this.serverPath, '--transport', 'stdio'];
            } else if (this.serverCommand === 'ts-node') {
                // Windows에서 전체 경로 사용
                spawnCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
                spawnArgs = ['ts-node', this.serverPath, '--transport', 'stdio'];
            }

            this.process = spawn(spawnCommand, spawnArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.messageBuffer = '';

            this.process.stdout.on('data', (data) => {
                this.handleIncomingData(data);
            });

            this.process.stderr.on('data', (data) => {
                console.error(`🔥 ${this.serverName} MCP STDERR:`, data.toString().trim());
            });

            this.process.on('close', (code) => {
                console.log(`🔚 ${this.serverName} MCP 프로세스 종료: ${code}`);
                this.isInitialized = false;
                this.process = null;
                this.rejectAllPending('프로세스 종료됨');
            });

            this.process.on('error', (error) => {
                console.error(`🔥 ${this.serverName} MCP 프로세스 오류:`, error);
                this.isInitialized = false;
                reject(error);
            });

            this.performInitialization()
                .then(() => {
                    this.isInitialized = true;
                    console.log(`✅ ${this.serverName} MCP 클라이언트 초기화 완료`);
                    resolve(true);
                })
                .catch(reject);

            setTimeout(() => {
                if (!this.isInitialized) {
                    console.log(`⏰ ${this.serverName} MCP 초기화 타임아웃`);
                    this.cleanup();
                    reject(new Error(`${this.serverName} 초기화 타임아웃`));
                }
            }, 15000);
        });
    }

    handleIncomingData(data) {
        this.messageBuffer += data.toString();
        const lines = this.messageBuffer.split('\n');
        this.messageBuffer = lines.pop() || '';

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
                this.processMessage(trimmedLine);
            }
        }
    }

    processMessage(line) {
        try {
            const message = JSON.parse(line);
            console.log(`📨 ${this.serverName} MCP 메시지 수신:`, JSON.stringify(message, null, 2));

            if (message.id && this.pendingRequests.has(message.id)) {
                const { resolve, reject } = this.pendingRequests.get(message.id);
                this.pendingRequests.delete(message.id);

                if (message.error) {
                    console.error(`❌ ${this.serverName} MCP 오류 응답:`, message.error);
                    reject(new Error(message.error.message || 'MCP 오류'));
                } else {
                    console.log(`✅ ${this.serverName} MCP 성공 응답`);
                    resolve(message.result);
                }
            }
        } catch (e) {
            console.log(`📄 ${this.serverName} Non-JSON 메시지:`, line);
        }
    }

    async performInitialization() {
        const initResult = await this.sendRequest('initialize', {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            clientInfo: { name: `${this.serverName.toLowerCase()}-mcp-client`, version: "1.0.0" }
        });

        console.log(`✅ ${this.serverName} 초기화 응답 받음:`, initResult);

        await this.sendNotification('notifications/initialized', {});
        console.log(`✅ ${this.serverName} initialized 알림 전송 완료`);

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    async sendRequest(method, params) {
        const requestId = this.requestId++;
        const request = {
            jsonrpc: "2.0",
            id: requestId,
            method: method,
            params: params
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });

            console.log(`📤 ${this.serverName} 요청 전송:`, JSON.stringify(request, null, 2));
            this.process.stdin.write(JSON.stringify(request) + '\n');

            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error(`${this.serverName} 요청 타임아웃: ${method}`));
                }
            }, 30000);
        });
    }

    async sendNotification(method, params) {
        const notification = {
            jsonrpc: "2.0",
            method: method,
            params: params
        };

        console.log(`📢 ${this.serverName} 알림 전송:`, JSON.stringify(notification, null, 2));
        this.process.stdin.write(JSON.stringify(notification) + '\n');
    }

    async callTool(toolName, params = {}) {
        if (!this.isInitialized || !this.process || this.process.killed) {
            throw new Error(`${this.serverName} MCP 클라이언트가 초기화되지 않음`);
        }

        console.log(`🔧 ${this.serverName} 도구 호출: ${toolName}`, params);

        try {
            const result = await this.sendRequest('tools/call', {
                name: toolName,
                arguments: params
            });

            console.log(`🎉 ${this.serverName} 도구 호출 성공:`, result);
            return result;
        } catch (error) {
            console.error(`❌ ${this.serverName} 도구 호출 실패 (${toolName}):`, error.message);
            throw error;
        }
    }

    rejectAllPending(reason) {
        for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    cleanup() {
        if (this.process && !this.process.killed) {
            this.process.kill();
        }
        this.isInitialized = false;
        this.process = null;
        this.rejectAllPending('클라이언트 정리됨');
    }
}

// 전역 MCP 클라이언트 인스턴스들
let mariaDBClient = null;
let pineconeClient = null;

// MariaDB MCP 클라이언트 가져오기
async function getMariaDBClient() {
    if (!mariaDBClient) {
        const serverPath = path.join(__dirname, '..', 'mcp-servers', 'mcp-server-mariadb', 'src', 'server.py');
        mariaDBClient = new MCPClient('MariaDB', serverPath, 'python');
    }

    if (!mariaDBClient.isInitialized) {
        await mariaDBClient.initialize();
    }

    return mariaDBClient;
}

// Pinecone MCP 클라이언트 가져오기
async function getPineconeClient() {
    if (!pineconeClient) {
        // Windows 호환 경로 - 빌드된 JavaScript 파일 사용
        const serverPath = path.join(__dirname, '..', 'mcp-servers', 'mcp-server-pinecone', 'dist', 'index.js');
        pineconeClient = new MCPClient('Pinecone', serverPath, 'node');
    }

    if (!pineconeClient.isInitialized) {
        await pineconeClient.initialize();
    }

    return pineconeClient;
}

// MCP 응답 데이터 추출 함수
function extractMCPData(mcpResult) {
    console.log('🔍 MCP 응답 데이터 추출 시작:', JSON.stringify(mcpResult, null, 2));

    let extractedData = null;

    if (mcpResult?.structuredContent?.result) {
        extractedData = mcpResult.structuredContent.result;
        console.log('✅ structuredContent.result에서 데이터 추출');
    } else if (mcpResult?.content?.[0]?.text) {
        try {
            const jsonText = mcpResult.content[0].text;
            extractedData = JSON.parse(jsonText);
            console.log('✅ content[0].text JSON 파싱으로 데이터 추출');
        } catch (e) {
            console.log('⚠️ content[0].text JSON 파싱 실패, 원본 텍스트 사용');
            extractedData = mcpResult.content[0].text;
        }
    } else if (Array.isArray(mcpResult)) {
        extractedData = mcpResult;
        console.log('✅ 직접 배열 형태로 데이터 추출');
    } else if (mcpResult?.result) {
        extractedData = mcpResult.result;
        console.log('✅ result 속성에서 데이터 추출');
    } else {
        extractedData = mcpResult;
        console.log('⚠️ 원본 형태 그대로 사용');
    }

    console.log('📊 최종 추출된 데이터:', extractedData);
    return extractedData;
}

// MariaDB 쿼리 함수
async function queryMariaDB(sql, database = null, parameters = []) {
    try {
        console.log(`🔍 MariaDB 쿼리 실행: ${sql}`);
        if (parameters.length) {
            console.log(`🧩 파라미터: ${JSON.stringify(parameters)}`);
        }

        const client = await getMariaDBClient();

        const mcpResult = await client.callTool('execute_sql', {
            sql_query: sql,
            database_name: database || process.env.DB_NAME || 'fire',
            parameters: parameters
        });

        // ✅ MCP 응답 에러 처리 먼저!
        if (mcpResult?.isError || mcpResult?.content?.[0]?.text?.startsWith("Error")) {
            const errorMsg = mcpResult?.content?.[0]?.text || 'Unknown MCP error';
            console.error('❌ MCP 실행 오류:', errorMsg);
            return { success: false, data: [], error: errorMsg };
        }

        // ✅ 정상 데이터 처리
        const extractedData = extractMCPData(mcpResult);

        if (Array.isArray(extractedData) && extractedData.length >= 0) {
            console.log(`📊 MariaDB 쿼리 성공: ${extractedData.length}개 행 반환`);
            return { success: true, data: extractedData };
        } else if (extractedData !== null && extractedData !== undefined) {
            console.log('📊 MariaDB 쿼리 성공: 단일 값 또는 객체 반환');
            return { success: true, data: [extractedData] };
        } else {
            console.log('❌ 추출된 데이터가 유효하지 않음');
            return { success: false, data: [], error: '유효하지 않은 데이터 형식' };
        }
    } catch (error) {
        console.error('❌ MariaDB 쿼리 오류:', error.message);
        return { success: false, data: [], error: error.message };
    }
}



// Pinecone 벡터 검색 함수
async function searchPinecone(query, indexName, topK = 5) {
    try {
        console.log(`🎯 Pinecone 벡터 검색: ${query}`);

        const client = await getPineconeClient();

        // 정확한 Pinecone MCP 매개변수 구조
        const mcpResult = await client.callTool('search-records', {
            name: indexName || process.env.PINECONE_INDEX_NAME || 'chatbot',
            namespace: '',
            query: {
                text: query,
                topK: topK,
                inputs: {
                    text: query
                }
            },
            includeMetadata: true
        });

        const extractedData = extractMCPData(mcpResult);

        if (Array.isArray(extractedData)) {
            console.log(`🎯 Pinecone 검색 성공: ${extractedData.length}개 결과 반환`);
            return { success: true, data: extractedData };
        } else {
            console.log('📊 Pinecone 검색 성공: 단일 결과 반환');
            return { success: true, data: [extractedData] };
        }
    } catch (error) {
        console.error('❌ Pinecone 검색 오류:', error.message);
        return { success: false, data: [], error: error.message };
    }
}

// Pinecone에 벡터 저장 함수
async function storeToPinecone(indexName, records) {
    try {
        console.log(`📚 Pinecone에 벡터 저장: ${records.length}개`);

        const client = await getPineconeClient();

        // 실제 도구명과 매개변수: 'name' 사용
        const mcpResult = await client.callTool('upsert-records', {
            name: indexName || process.env.PINECONE_INDEX_NAME || 'chatbot',
            records: records
        });

        const extractedData = extractMCPData(mcpResult);
        console.log('✅ Pinecone 저장 완료');
        return { success: true, data: extractedData };
    } catch (error) {
        console.error('❌ Pinecone 저장 오류:', error.message);
        return { success: false, data: [], error: error.message };
    }
}

// === API 엔드포인트들 ===

// 1. 건강 상태 확인
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            openai: !!process.env.OPENAI_API_KEY,
            mariadb: mariaDBClient?.isInitialized || false,
            pinecone: pineconeClient?.isInitialized || false
        }
    });
});

// 2. MCP 서버들 연결 테스트
app.get('/api/test-mcp', async (req, res) => {
    try {
        console.log('🧪 MCP 서버들 연결 테스트 시작...');

        const results = {};

        // MariaDB MCP 테스트
        try {
            const mariaClient = await getMariaDBClient();
            const testQuery = await mariaClient.callTool('execute_sql', {
                sql_query: 'SELECT 1 as test_value',
                database_name: 'fire',
                parameters: []
            });

            results.mariadb = {
                success: true,
                data: extractMCPData(testQuery),
                message: 'MariaDB MCP 연결 성공'
            };
        } catch (error) {
            results.mariadb = {
                success: false,
                error: error.message
            };
        }

        // Pinecone MCP 테스트
        try {
            const pineClient = await getPineconeClient();

            // 실제 도구명과 매개변수: 'name' 사용
            const statusResult = await pineClient.callTool('describe-index-stats', {
                name: process.env.PINECONE_INDEX_NAME || 'chatbot'
            });

            results.pinecone = {
                success: true,
                data: extractMCPData(statusResult),
                message: 'Pinecone MCP 연결 성공'
            };
        } catch (error) {
            results.pinecone = {
                success: false,
                error: error.message
            };
        }

        res.json({
            success: true,
            tests: results,
            message: 'MCP 서버들 연결 테스트 완료'
        });

    } catch (error) {
        console.error('MCP 테스트 실패:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 3. 직원 데이터를 Pinecone에 저장
app.post('/api/store-employees', async (req, res) => {
    try {
        console.log('📚 직원 데이터를 Pinecone에 저장 시작...');

        // 1. MariaDB에서 직원 데이터 조회
        const result = await queryMariaDB('SELECT * FROM JobMapRaws LIMIT 100');

        if (!result.success || result.data.length === 0) {
            return res.status(400).json({
                success: false,
                error: '저장할 직원 데이터가 없습니다'
            });
        }

        const employees = result.data;

        // 2. 직원 데이터를 벡터화하여 Pinecone에 저장
        const indexName = process.env.PINECONE_INDEX_NAME || 'chatbot';
        const records = employees.map(employee => {
            const employeeText = `
                이름: ${employee.JobTitle || ''}
                부서: ${employee.Category || ''}
                그룹: ${employee.Group || ''}
                업무: ${employee.JobDetail || ''}
                위치: ${employee.Location || ''}
                연락처: ${employee.Tel || ''} ${employee.Mobile || ''}
                이메일: ${employee.ComeMail || ''}
            `.trim();

            return {
                id: `employee_${employee.Id}`,
                // 실제로는 OpenAI 임베딩 생성 후 values에 넣어야 함
                // 지금은 텍스트만 저장
                metadata: {
                    id: employee.Id,
                    jobTitle: employee.JobTitle || '',
                    category: employee.Category || '',
                    group: employee.Group || '',
                    jobDetail: employee.JobDetail || '',
                    location: employee.Location || '',
                    tel: employee.Tel || '',
                    mobile: employee.Mobile || '',
                    email: employee.ComeMail || '',
                    text: employeeText
                }
            };
        });

        // 3. Pinecone에 저장
        const storeResult = await storeToPinecone(indexName, records);

        if (storeResult.success) {
            res.json({
                success: true,
                message: `${employees.length}명의 직원 데이터 저장 완료`,
                totalEmployees: employees.length
            });
        } else {
            res.status(500).json({
                success: false,
                error: storeResult.error
            });
        }

    } catch (error) {
        console.error('직원 데이터 저장 오류:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 4. 하이브리드 검색 (Pinecone + MariaDB)
app.post('/api/hybrid-search', async (req, res) => {
    try {
        const { query } = req.body;
        console.log(`🔍 하이브리드 검색: ${query}`);

        if (!query) {
            return res.status(400).json({
                success: false,
                error: '검색 쿼리가 필요합니다'
            });
        }

        const results = {};

        // 1. Pinecone 벡터 검색
        try {
            const indexName = process.env.PINECONE_INDEX_NAME || 'chatbot';
            const vectorResult = await searchPinecone(query, indexName, 5);
            results.vectorSearch = vectorResult;
            console.log(`🎯 벡터 검색 결과: ${vectorResult.data?.length || 0}개`);
        } catch (error) {
            console.error('벡터 검색 오류:', error.message);
            results.vectorSearch = { success: false, error: error.message };
        }

        // 2. MariaDB 구조화된 검색
        try {
            const sqlQuery = `
                SELECT * FROM JobMapRaws
                WHERE JobTitle LIKE '%${query}%'
                   OR Category LIKE '%${query}%'
                   OR JobDetail LIKE '%${query}%'
                   OR Location LIKE '%${query}%'
                    LIMIT 10
            `;

            const dbResult = await queryMariaDB(sqlQuery);
            results.databaseSearch = dbResult;
            console.log(`🗄️ DB 검색 결과: ${dbResult.data?.length || 0}개`);
        } catch (error) {
            console.error('DB 검색 오류:', error.message);
            results.databaseSearch = { success: false, error: error.message };
        }

        res.json({
            success: true,
            query: query,
            results: results,
            totalResults: (results.vectorSearch?.data?.length || 0) + (results.databaseSearch?.data?.length || 0)
        });

    } catch (error) {
        console.error('하이브리드 검색 오류:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 5. 향상된 챗봇 API (두 MCP 서버 활용)
app.post('/api/chat', async (req, res) => {
    try {
        const { message, userId = 'default' } = req.body;
        console.log(`💬 [${userId}] 사용자 질문: ${message}`);

        let vectorContext = '';
        let dbData = null;

        // 1. Pinecone 벡터 검색으로 관련 정보 찾기
        try {
            console.log('🎯 벡터 검색으로 관련 정보 찾는 중...');
            const indexName = process.env.PINECONE_INDEX_NAME || 'chatbot';
            const vectorResult = await searchPinecone(message, indexName, 3);

            if (vectorResult.success && vectorResult.data.length > 0) {
                vectorContext = vectorResult.data
                    .filter(match => match.score && match.score > 0.7) // 높은 유사도만
                    .map(match => match.metadata?.text || '')
                    .join('\n\n');

                console.log(`✅ 벡터 검색 결과: ${vectorResult.data.length}개`);
            }
        } catch (error) {
            console.error('벡터 검색 실패:', error.message);
        }

        // 2. GPT로 질문 분석 및 SQL 생성
        console.log('🤖 GPT로 질문 분석...');
        const analysisPrompt = `
사용자 질문: "${message}"

벡터 검색 결과:
${vectorContext || '관련 정보 없음'}

데이터베이스 정보:
- 데이터베이스명: fire
- 주요 테이블: JobMapRaws
- JobMapRaws 테이블 컬럼: Group, Category, JobDetail, JobTitle, ComeMail, Tel, Mobile, Location, Id

이 질문에 답하기 위해 데이터베이스 조회가 필요한지 판단하고, 필요하다면 JobMapRaws 테이블을 대상으로 적절한 SQL 쿼리를 생성해주세요.

응답 형식 (JSON만):
{
  "needsDatabase": true/false,
  "sqlQuery": "SELECT ... FROM JobMapRaws WHERE ... (필요한 경우만)",
  "reasoning": "판단 이유"
}
`;

        const analysisResponse = await callOpenAI([
            { role: "user", content: analysisPrompt }
        ], 0.3);

        let analysis = { needsDatabase: false };

        try {
            const cleanResponse = analysisResponse.replace(/```json\n?|\n?```/g, '').trim();
            analysis = JSON.parse(cleanResponse);
            console.log('📋 분석 결과:', analysis);

            // 3. 필요시 MariaDB 조회
            if (analysis.needsDatabase && analysis.sqlQuery) {
                console.log('🔍 데이터베이스 조회 실행...');
                const queryResult = await queryMariaDB(analysis.sqlQuery);

                if (queryResult.success && queryResult.data.length > 0) {
                    dbData = queryResult.data;
                    console.log(`✅ DB 조회 성공: ${dbData.length}개 행 발견`);
                }
            }
        } catch (e) {
            console.log('⚠️ 분석 응답 파싱 실패:', e.message);
        }

        // 4. 최종 답변 생성
        console.log('💭 최종 답변 생성...');

        let finalPrompt;
        if ((vectorContext && vectorContext.trim()) || (dbData && dbData.length > 0)) {
            finalPrompt = `
사용자 질문: "${message}"

벡터 검색으로 찾은 관련 정보:
${vectorContext || '없음'}

데이터베이스에서 찾은 정보:
${dbData ? JSON.stringify(dbData, null, 2) : '없음'}

위 정보들을 종합하여 사용자 질문에 대해 친근하고 상세한 답변을 한국어로 작성해주세요.

답변 가이드라인:
1. 벡터 검색과 DB 검색 결과를 모두 활용
2. 직원의 이름, 직책, 연락처, 업무 내용 등을 포함
3. 친근하고 도움이 되는 톤으로 작성
4. 추가로 궁금한 점이 있으면 언제든 물어보라고 안내

반드시 한국어로 자연스러운 문장으로 답변해주세요.
`;
        } else {
            finalPrompt = `
사용자 질문: "${message}"

검색 결과: 관련 정보를 찾을 수 없습니다.

사용자에게 친근하게 정보를 찾을 수 없다고 안내하고, 다른 방식으로 도움을 드릴 수 있는지 물어보는 답변을 한국어로 작성해주세요.
`;
        }

        const finalResponse = await callOpenAI([
            {
                role: "system",
                content: "당신은 회사 직원 정보를 제공하는 친근하고 도움이 되는 AI 어시스턴트입니다. 벡터 검색과 데이터베이스 검색 결과를 모두 활용하여 정확하고 유용한 정보를 제공합니다."
            },
            { role: "user", content: finalPrompt }
        ]);

        res.json({
            success: true,
            response: finalResponse,
            debug: {
                usedVectorSearch: !!vectorContext,
                usedDatabase: analysis?.needsDatabase || false,
                sqlQuery: analysis?.sqlQuery || null,
                vectorResultCount: vectorContext ? vectorContext.split('\n\n').length : 0,
                dbResultCount: Array.isArray(dbData) ? dbData.length : 0,
                reasoning: analysis?.reasoning || '분석 실패'
            }
        });

    } catch (error) {
        console.error('💥 챗봇 API 오류:', error);
        res.status(500).json({
            success: false,
            error: '처리 중 오류가 발생했습니다: ' + error.message
        });
    }
});

// 6. MCP 서버들 재연결
app.post('/api/mcp-reconnect', async (req, res) => {
    try {
        console.log('🔄 MCP 서버들 재연결 시도...');

        const results = {};

        // MariaDB 클라이언트 재연결
        if (mariaDBClient) {
            mariaDBClient.cleanup();
            mariaDBClient = null;
        }

        try {
            const mariaClient = await getMariaDBClient();
            results.mariadb = {
                success: true,
                message: 'MariaDB MCP 클라이언트 재연결 완료',
                isInitialized: mariaClient.isInitialized
            };
        } catch (error) {
            results.mariadb = {
                success: false,
                error: error.message
            };
        }

        // Pinecone 클라이언트 재연결
        if (pineconeClient) {
            pineconeClient.cleanup();
            pineconeClient = null;
        }

        try {
            const pineClient = await getPineconeClient();
            results.pinecone = {
                success: true,
                message: 'Pinecone MCP 클라이언트 재연결 완료',
                isInitialized: pineClient.isInitialized
            };
        } catch (error) {
            results.pinecone = {
                success: false,
                error: error.message
            };
        }

        res.json({
            success: true,
            results: results,
            message: 'MCP 서버들 재연결 시도 완료'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 7. Pinecone 도구들 테스트
app.get('/api/test-pinecone-tools', async (req, res) => {
    try {
        console.log('🧪 Pinecone 도구별 테스트 시작...');

        const client = await getPineconeClient();
        const results = {};

        // Pinecone MCP 서버에서 사용 가능한 도구들 테스트 (실제 도구명들)
        const tools = [
            { name: 'list-indexes', params: {} },
            { name: 'describe-index-stats', params: { name: process.env.PINECONE_INDEX_NAME || 'chatbot' } },
            { name: 'describe-index', params: { name: process.env.PINECONE_INDEX_NAME || 'chatbot' } }
        ];

        for (const tool of tools) {
            try {
                console.log(`🔧 Pinecone ${tool.name} 테스트...`);
                const mcpResult = await client.callTool(tool.name, tool.params);
                const extractedData = extractMCPData(mcpResult);

                results[tool.name] = {
                    success: true,
                    data: extractedData,
                    rawMcpResult: mcpResult
                };
            } catch (error) {
                results[tool.name] = {
                    success: false,
                    error: error.message
                };
            }
        }

        res.json({
            success: true,
            toolTests: results,
            message: 'Pinecone 도구 테스트 완료'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 8. MariaDB 도구들 테스트
app.get('/api/test-mariadb-tools', async (req, res) => {
    try {
        console.log('🧪 MariaDB 도구별 테스트 시작...');

        const client = await getMariaDBClient();
        const results = {};

        const tools = [
            {
                name: 'list_databases',
                params: {}
            },
            {
                name: 'list_tables',
                params: { database_name: 'fire' }
            },
            {
                name: 'execute_sql',
                params: {
                    sql_query: 'SELECT COUNT(*) as total_rows FROM JobMapRaws',
                    database_name: 'fire',
                    parameters: []
                }
            }
        ];

        for (const tool of tools) {
            try {
                console.log(`🔧 MariaDB ${tool.name} 테스트...`);
                const mcpResult = await client.callTool(tool.name, tool.params);
                const extractedData = extractMCPData(mcpResult);

                results[tool.name] = {
                    success: true,
                    data: extractedData,
                    rawMcpResult: mcpResult
                };
            } catch (error) {
                results[tool.name] = {
                    success: false,
                    error: error.message
                };
            }
        }

        res.json({
            success: true,
            toolTests: results,
            message: 'MariaDB 도구 테스트 완료'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 프로세스 종료 시 정리
process.on('SIGINT', async () => {
    console.log('🛑 서버 종료 중...');
    if (mariaDBClient) {
        mariaDBClient.cleanup();
    }
    if (pineconeClient) {
        pineconeClient.cleanup();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 서버 종료 중...');
    if (mariaDBClient) {
        mariaDBClient.cleanup();
    }
    if (pineconeClient) {
        pineconeClient.cleanup();
    }
    process.exit(0);
});

// 서버 시작
app.listen(port, () => {
    console.log(`🚀 하이브리드 MCP API 서버가 http://localhost:${port} 에서 실행 중입니다.`);
    console.log('\n💡 API 엔드포인트:');
    console.log('   1. 건강 상태: GET /api/health');
    console.log('   2. MCP 서버들 테스트: GET /api/test-mcp');
    console.log('   3. 직원 데이터 저장: POST /api/store-employees');
    console.log('   4. 하이브리드 검색: POST /api/hybrid-search {"query": "검색어"}');
    console.log('   5. 향상된 챗봇: POST /api/chat {"message": "질문"}');
    console.log('   6. MCP 재연결: POST /api/mcp-reconnect');
    console.log('   7. Pinecone 도구 테스트: GET /api/test-pinecone-tools');
    console.log('   8. MariaDB 도구 테스트: GET /api/test-mariadb-tools');
    console.log('\n🔧 필요한 MCP 서버들:');
    console.log('   - MariaDB MCP 서버 (기존)');
    console.log('   - Pinecone MCP 서버 (GitHub에서 받은 것)');
    console.log('\n🚀 실행 순서:');
    console.log('   1. MariaDB MCP 서버 실행');
    console.log('   2. Pinecone MCP 서버 실행');
    console.log('   3. 이 API 서버 실행 (node server.js)');
});
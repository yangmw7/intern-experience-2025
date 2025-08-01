# 한국SGS 현장실습 보고서

## 📋 실습 개요
- **기관**: 한국SGS D&I 개발팀
- **기간**: 20일
- **목표**: ARS 시스템에 AI 자연어 처리 기능 추가

## 🛠 기술 스택
- **Backend**: .NET Core, C#, MariaDB
- **Frontend**: Vue3
- **AI/ML**: LangChain, OpenAI GPT-4o, MCP Server
- **DevOps**: Docker, Git
- **Others**: Google Cloud TTS, Pinecone

## 📅 주차별 실습 내용

### 1주차: 환경 설정 및 기초 학습
- JetBrains, Docker 설치 및 설정
- TCP/IP, REST API, L4 개념 학습
- SGS 애플리케이션 Docker 빌드 및 Swagger 테스트

### 2주차: 백엔드 개발
- .NET Core 의존성 주입 학습 (AddScoped, AddTransient, AddSingleton)
- 인증/인가 시스템 이해
- Roles 관리 API 개발 (Repository-Service-Controller 3계층)
- JWT 토큰 기반 사용자 인증 구현

### 3주차: 프론트엔드 연동
- Vue3 기반 권한 관리 UI 구현
- 권한 추가/수정/삭제 API 연동
- Toast 에러 메시지 처리
- 체크박스 기반 다중 선택 삭제 기능
- RoleClaims 테이블 관리자 추적 기능

### 4주차: AI 시스템 구현
- LangChain + SQLite + GPT-4o 연동
- Streamlit 웹 인터페이스 구현
- Google Cloud TTS 음성 출력 기능
- MCP 서버 구축 (SQLite → MariaDB 전환)
- ChatGPT API 챗봇 시스템
- Docker 배포 (https://snap.kr.sgs.com/mcp-api/)
- MariaDB + Pinecone 멀티 MCP 서버 에이전트

## 🚀 주요 구현 결과

### 1. ARS AI 시스템
```python
# LangChain 기반 자연어 DB 질의응답
- OpenAI GPT-4o + SQLite 연동
- 음성 TTS 출력 기능
- Streamlit 웹 인터페이스
```

### 2. 권한 관리 시스템
- Roles CRUD API 구현
- Vue3 UI 연동
- JWT 기반 관리자 추적

### 3. MCP 서버 시스템
- 회사 내부 DB 연동
- 챗봇 API 서버 구축
- 벡터 DB 기반 기억력 AI 에이전트

## 📈 기술적 성장

### Before
- Spring Boot만 경험
- AI 도구 사용만 가능

### After
- .NET Core, Vue3 풀스택 개발
- Docker 컨테이너화
- AI/ML 프로젝트 구현
- MCP 서버 구축
- 실무 Git 협업

## 🎯 향후 계획
1. AI/ML 기술 심화 학습 (RAG, Vector DB)
2. .NET Core + Vue3 포트폴리오 확장
3. AI 개발자/풀스택 개발자 취업 준비

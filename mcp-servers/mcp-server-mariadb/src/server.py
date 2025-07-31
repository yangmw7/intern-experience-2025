# server.py
import asyncio
import logging
import argparse
import sys
import json
from typing import List, Dict, Any, Optional
from functools import partial

import aiomysql
import anyio
from fastmcp import FastMCP, Context

# Import configuration settings
from config import (
    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
    MCP_READ_ONLY, MCP_MAX_POOL_SIZE, EMBEDDING_PROVIDER,
    logger
)

# Import EmbeddingService for vector store creation
from embeddings import EmbeddingService

# Singleton instance for embedding service
embedding_service = None
if EMBEDDING_PROVIDER is not None:
    embedding_service = EmbeddingService()

# --- MariaDB MCP Server Class ---
class MariaDBServer:
    """
    MCP Server exposing tools to interact with a MariaDB database.
    Manages the database connection pool.
    """
    def __init__(self, server_name="MariaDB_Server", autocommit=True):
        self.mcp = FastMCP(server_name)
        self.pool: Optional[aiomysql.Pool] = None
        self.autocommit = autocommit
        self.is_read_only = MCP_READ_ONLY
        logger.info(f"🔧 {server_name} 초기화 중...")
        if self.is_read_only:
            logger.warning("⚠️ 서버가 READ-ONLY 모드로 실행됩니다. 쓰기 작업이 비활성화되었습니다.")

    async def initialize_pool(self):
        """Initializes the aiomysql connection pool within the running event loop."""
        if not all([DB_USER, DB_PASSWORD]):
             logger.error("❌ 데이터베이스 자격 증명이 누락되어 풀을 초기화할 수 없습니다.")
             raise ConnectionError("Missing database credentials for pool initialization.")

        if self.pool is not None:
            logger.info("✅ 연결 풀이 이미 초기화되었습니다.")
            return

        try:
            logger.info(f"🔗 연결 풀 생성 중: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME} (최대 크기: {MCP_MAX_POOL_SIZE})")
            self.pool = await aiomysql.create_pool(
                host=DB_HOST,
                port=DB_PORT,
                user=DB_USER,
                password=DB_PASSWORD,
                db=DB_NAME,
                minsize=1,
                maxsize=MCP_MAX_POOL_SIZE,
                autocommit=self.autocommit,
                charset='utf8mb4'
            )
            logger.info("✅ 데이터베이스 연결 풀이 성공적으로 초기화되었습니다.")
        except Exception as e:
            logger.error(f"❌ 데이터베이스 연결 풀 초기화 실패: {e}", exc_info=True)
            self.pool = None
            raise

    async def close_pool(self):
        """Closes the connection pool gracefully."""
        if self.pool:
            logger.info("🔚 데이터베이스 연결 풀 종료 중...")
            try:
                self.pool.close()
                await self.pool.wait_closed()
                logger.info("✅ 데이터베이스 연결 풀이 종료되었습니다.")
            except Exception as e:
                logger.error(f"❌ 연결 풀 종료 중 오류: {e}", exc_info=True)
            finally:
                self.pool = None

    async def _execute_query(self, sql: str, params: Optional[tuple] = None, database: Optional[str] = None) -> List[Dict[str, Any]]:
        """Helper function to execute SELECT queries using the pool."""
        if self.pool is None:
            logger.error("❌ 연결 풀이 초기화되지 않았습니다.")
            raise RuntimeError("Database connection pool not available.")

        # 허용된 쿼리 타입 확인 (READ-ONLY 모드용)
        allowed_prefixes = ('SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'USE', 'CREATE', 'EXPLAIN')
        query_upper = sql.strip().upper()
        is_allowed_read_query = any(query_upper.startswith(prefix) for prefix in allowed_prefixes)

        if self.is_read_only and not is_allowed_read_query:
             logger.warning(f"⚠️ READ-ONLY 모드에서 잠재적으로 쓰기 쿼리가 차단됨: {sql[:100]}...")
             raise PermissionError("Operation forbidden: Server is in read-only mode.")

        logger.info(f"🔍 쿼리 실행 중 (DB: {database or DB_NAME}): {sql[:100]}...")
        if params:
            logger.debug(f"📊 파라미터: {params}")

        conn = None
        try:
            async with self.pool.acquire() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    # 현재 데이터베이스 확인
                    current_db_query = "SELECT DATABASE()"
                    await cursor.execute(current_db_query)
                    current_db_result = await cursor.fetchone()
                    current_db_name = current_db_result.get('DATABASE()') if current_db_result else None
                    pool_db_name = DB_NAME
                    actual_current_db = current_db_name or pool_db_name

                    # 필요한 경우 데이터베이스 전환
                    if database and database != actual_current_db:
                        logger.info(f"🔄 데이터베이스 컨텍스트 전환: '{actual_current_db}' -> '{database}'")
                        await cursor.execute(f"USE `{database}`")

                    # 실제 쿼리 실행
                    await cursor.execute(sql, params or ())
                    results = await cursor.fetchall()

                    # 결과를 일반 딕셔너리로 변환 (JSON 직렬화 가능하도록)
                    converted_results = []
                    if results:
                        for row in results:
                            converted_row = {}
                            for key, value in row.items():
                                # 날짜, 시간 등을 문자열로 변환
                                if hasattr(value, 'isoformat'):
                                    converted_row[key] = value.isoformat()
                                elif isinstance(value, bytes):
                                    converted_row[key] = value.decode('utf-8', errors='ignore')
                                else:
                                    converted_row[key] = value
                            converted_results.append(converted_row)

                    logger.info(f"✅ 쿼리 실행 성공, {len(converted_results)}개 행 반환됨.")
                    return converted_results

        except Exception as e:
            conn_state = f"Connection: {'acquired' if conn else 'not acquired'}"
            logger.error(f"❌ 데이터베이스 쿼리 실행 오류 ({conn_state}): {e}", exc_info=True)
            raise RuntimeError(f"Database error: {e}") from e

    async def _database_exists(self, database_name: str) -> bool:
        """Checks if a database exists."""
        if not database_name:
            logger.warning(f"⚠️ _database_exists가 잘못된 database_name으로 호출됨: {database_name}")
            return False

        sql = "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s"
        try:
            results = await self._execute_query(sql, params=(database_name,), database='information_schema')
            return len(results) > 0
        except Exception as e:
            logger.error(f"❌ 데이터베이스 '{database_name}' 존재 확인 오류: {e}", exc_info=True)
            return False

    async def _table_exists(self, database_name: str, table_name: str) -> bool:
        """Checks if a table exists in the given database."""
        if not database_name or not table_name:
            logger.warning(f"⚠️ _table_exists가 잘못된 이름으로 호출됨: db='{database_name}', table='{table_name}'")
            return False

        sql = "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s"
        try:
            results = await self._execute_query(sql, params=(database_name, table_name), database='information_schema')
            return len(results) > 0
        except Exception as e:
            logger.error(f"❌ 테이블 '{database_name}.{table_name}' 존재 확인 오류: {e}", exc_info=True)
            return False

    # --- Tool Registration ---
    def register_tools(self):
        """Registers the class methods as MCP tools using @tool decorator."""
        if self.pool is None:
             logger.error("❌ 도구 등록 불가: 데이터베이스 풀이 초기화되지 않았습니다.")
             raise RuntimeError("Database pool must be initialized before registering tools.")

        # 1. 데이터베이스 목록 조회
        @self.mcp.tool
        async def list_databases() -> List[str]:
            """Lists all accessible databases on the connected MariaDB server."""
            logger.info("🔧 TOOL START: list_databases 호출됨.")
            sql = "SHOW DATABASES"
            try:
                results = await self._execute_query(sql)
                db_list = [row['Database'] for row in results if 'Database' in row]
                logger.info(f"✅ TOOL END: list_databases 완료. 데이터베이스 발견: {len(db_list)}개.")
                return db_list
            except Exception as e:
                logger.error(f"❌ TOOL ERROR: list_databases 실패: {e}", exc_info=True)
                raise

        # 2. 테이블 목록 조회
        @self.mcp.tool
        async def list_tables(database_name: str) -> List[str]:
            """Lists all tables within the specified database."""
            logger.info(f"🔧 TOOL START: list_tables 호출됨. database_name={database_name}")
            if not database_name:
                logger.warning(f"⚠️ TOOL WARNING: list_tables가 잘못된 database_name으로 호출됨: {database_name}")
                raise ValueError(f"Invalid database name provided: {database_name}")
            sql = "SHOW TABLES"
            try:
                results = await self._execute_query(sql, database=database_name)
                table_list = [list(row.values())[0] for row in results if row]
                logger.info(f"✅ TOOL END: list_tables 완료. 테이블 발견: {len(table_list)}개.")
                return table_list
            except Exception as e:
                logger.error(f"❌ TOOL ERROR: list_tables 실패 (database_name={database_name}): {e}", exc_info=True)
                raise

        # 3. 테이블 스키마 조회
        @self.mcp.tool
        async def get_table_schema(database_name: str, table_name: str) -> Dict[str, Any]:
            """Retrieves the schema for a specific table in a database."""
            logger.info(f"🔧 TOOL START: get_table_schema 호출됨. database_name={database_name}, table_name={table_name}")
            if not database_name or not table_name:
                logger.warning(f"⚠️ TOOL WARNING: get_table_schema가 잘못된 이름으로 호출됨")
                raise ValueError(f"Invalid database or table name provided")

            sql = f"DESCRIBE `{database_name}`.`{table_name}`"
            try:
                schema_results = await self._execute_query(sql)
                schema_info = {}
                if not schema_results:
                    exists_sql = "SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = %s AND table_name = %s"
                    exists_result = await self._execute_query(exists_sql, params=(database_name, table_name))
                    if not exists_result or exists_result[0]['count'] == 0:
                        logger.warning(f"⚠️ TOOL WARNING: 테이블 '{database_name}'.'{table_name}'을 찾을 수 없거나 접근할 수 없습니다.")
                        raise FileNotFoundError(f"Table '{database_name}'.'{table_name}' not found or inaccessible.")

                for row in schema_results:
                    col_name = row.get('Field')
                    if col_name:
                        schema_info[col_name] = {
                            'type': row.get('Type'),
                            'nullable': row.get('Null', '').upper() == 'YES',
                            'key': row.get('Key'),
                            'default': row.get('Default'),
                            'extra': row.get('Extra')
                        }
                logger.info(f"✅ TOOL END: get_table_schema 완료. 컬럼 발견: {len(schema_info)}개.")
                return schema_info
            except FileNotFoundError as e:
                logger.warning(f"⚠️ TOOL WARNING: get_table_schema 테이블 없음: {e}")
                raise e
            except Exception as e:
                logger.error(f"❌ TOOL ERROR: get_table_schema 실패: {e}", exc_info=True)
                raise RuntimeError(f"Could not retrieve schema for table '{database_name}.{table_name}'.")

        # 4. SQL 실행 (메인 도구)
        @self.mcp.tool
        async def execute_sql(sql_query: str, database_name: str, parameters: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
            """Executes a read-only SQL query against a specified database."""
            logger.info(f"🔧 TOOL START: execute_sql 호출됨. database_name={database_name}, sql_query={sql_query[:100]}...")

            if not sql_query:
                logger.error("❌ SQL 쿼리가 비어있습니다.")
                raise ValueError("SQL query cannot be empty")

            if not database_name:
                database_name = DB_NAME
                logger.info(f"🔄 database_name이 비어있어서 기본값 사용: {database_name}")

            # parameters를 tuple로 변환 (None이면 빈 tuple)
            param_tuple = tuple(parameters) if parameters else None
            if param_tuple:
                logger.debug(f"📊 파라미터: {param_tuple}")

            try:
                results = await self._execute_query(sql_query, params=param_tuple, database=database_name)
                logger.info(f"✅ TOOL END: execute_sql 완료. 반환된 행: {len(results)}개.")

                # 결과를 직접 반환 (FastMCP가 자동으로 적절한 형식으로 감쌀 것)
                return results
            except Exception as e:
                logger.error(f"❌ TOOL ERROR: execute_sql 실패: {e}", exc_info=True)
                raise

        # 5. 데이터베이스 생성
        @self.mcp.tool
        async def create_database(database_name: str) -> Dict[str, Any]:
            """Creates a new database if it doesn't exist."""
            logger.info(f"🔧 TOOL START: create_database 호출됨. database: '{database_name}'")
            if not database_name:
                logger.error(f"❌ 생성용 database_name이 잘못됨: '{database_name}'")
                raise ValueError(f"Invalid database_name for creation: '{database_name}'")

            # 존재 여부 확인
            if await self._database_exists(database_name):
                message = f"Database '{database_name}' already exists."
                logger.info(f"✅ TOOL END: create_database. {message}")
                return {"status": "exists", "message": message, "database_name": database_name}

            sql = f"CREATE DATABASE IF NOT EXISTS `{database_name}`"

            try:
                await self._execute_query(sql, database=None)
                message = f"Database '{database_name}' created successfully."
                logger.info(f"✅ TOOL END: create_database. {message}")
                return {"status": "success", "message": message, "database_name": database_name}
            except Exception as e:
                error_message = f"Failed to create database '{database_name}'."
                logger.error(f"❌ TOOL ERROR: create_database. {error_message} 오류: {e}", exc_info=True)
                raise RuntimeError(f"{error_message} Reason: {str(e)}")

        logger.info("✅ @tool 데코레이터를 사용하여 MCP 도구 등록 완료.")

    # --- Async Main Server Logic ---
    async def run_async_server(self, transport="stdio", host="127.0.0.1", port=9001):
        try:
            # 1. Initialize pool
            await self.initialize_pool()
            logger.info("✅ [MCP] MariaDB 연결 성공 및 풀 생성 완료")

            # 2. Register tools
            self.register_tools()
            logger.info("✅ [MCP] MCP 도구 등록 완료 (list_databases, execute_sql 등)")

            # 3. 자동 테이블 조회 및 샘플 데이터 출력
            try:
                logger.info("📋 서버 시작 후, 테이블 목록 및 샘플 데이터 자동 출력:")

                # 테이블 목록 조회
                table_check_sql = "SHOW TABLES"
                table_results = await self._execute_query(table_check_sql, database=DB_NAME)

                if table_results:
                    logger.info(f"📊 총 {len(table_results)}개 테이블 발견:")
                    for i, row in enumerate(table_results, start=1):
                        table_name = list(row.values())[0]
                        logger.info(f"   {i}. {table_name}")

                        # JobMapRaws 테이블에서 샘플 데이터 조회
                        if table_name == 'JobMapRaws':
                            try:
                                sample_sql = f"SELECT * FROM {table_name} LIMIT 3"
                                sample_results = await self._execute_query(sample_sql, database=DB_NAME)
                                logger.info(f"📝 {table_name} 샘플 데이터 ({len(sample_results)}개 행):")
                                for j, sample_row in enumerate(sample_results, start=1):
                                    logger.info(f"      행 {j}: {dict(sample_row)}")
                            except Exception as sample_error:
                                logger.warning(f"⚠️ {table_name} 샘플 데이터 조회 실패: {sample_error}")
                else:
                    logger.warning("⚠️ 테이블이 존재하지 않습니다.")

            except Exception as e:
                logger.error(f"❌ 테이블 목록 조회 실패: {e}", exc_info=True)

            # 4. Prepare transport
            logger.info(f"✅ [MCP] 서버 시작 완료 (Transport: {transport})")
            transport_kwargs = {}
            if transport == "sse":
                transport_kwargs = {"host": host, "port": port}
                logger.info(f"🌐 {transport}를 통한 MCP 서버 시작: {host}:{port}")
            elif transport == "stdio":
                logger.info(f"📡 {transport}를 통한 MCP 서버 시작...")
                # STDIO 모드에서는 로그 레벨을 높여서 출력 간섭 최소화
                logger.setLevel(logging.WARNING)
            else:
                logger.error(f"❌ 지원되지 않는 전송 타입: {transport}")
                return

            # 5. Run FastMCP
            await self.mcp.run_async(transport=transport, **transport_kwargs)

        except (ConnectionError, Exception) as e:
            logger.critical(f"💥 서버 설정 실패: {e}", exc_info=True)
            raise
        finally:
            await self.close_pool()

# --- Main Execution Block ---
if __name__ == "__main__":
    # 로깅 설정 개선
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stderr)  # STDERR로 로그 출력 (STDOUT은 MCP 통신용)
        ]
    )

    parser = argparse.ArgumentParser(description="MariaDB MCP Server")
    parser.add_argument('--transport', type=str, default='stdio', choices=['stdio', 'sse'],
                        help='MCP transport protocol (stdio or sse)')
    parser.add_argument('--host', type=str, default='127.0.0.1',
                        help='Host for SSE transport')
    parser.add_argument('--port', type=int, default=9001,
                        help='Port for SSE transport')
    args = parser.parse_args()

    # 1. Create the server instance
    server = MariaDBServer()
    exit_code = 0

    try:
        # 2. Use anyio.run to manage the event loop and call the main async server logic
        anyio.run(
            partial(server.run_async_server, transport=args.transport, host=args.host, port=args.port)
        )
        logger.info("✅ 서버가 정상적으로 종료되었습니다.")

    except KeyboardInterrupt:
         logger.info("🛑 사용자에 의해 서버 실행이 중단되었습니다.")
    except Exception as e:
         logger.critical(f"💥 서버 시작 실패 또는 크래시: {e}", exc_info=True)
         exit_code = 1
    finally:
        logger.info(f"🔚 서버가 종료 코드 {exit_code}로 종료됩니다.")
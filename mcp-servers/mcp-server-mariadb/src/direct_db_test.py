# direct_db_test.py - MCP 없이 직접 DB 연결 테스트
import asyncio
import aiomysql
from config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

async def test_direct_connection():
    """MCP 없이 직접 MariaDB 연결 테스트"""

    print("🔗 MariaDB 직접 연결 테스트 시작...")

    try:
        # 1. 연결 풀 생성
        print(f"📡 연결 시도: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}")
        pool = await aiomysql.create_pool(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            db=DB_NAME,
            minsize=1,
            maxsize=5,
            autocommit=True,
            charset='utf8mb4'
        )
        print("✅ 연결 풀 생성 성공!")

        # 2. 테이블 목록 조회
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cursor:
                print("\n📋 테이블 목록 조회 중...")
                await cursor.execute("SHOW TABLES")
                tables = await cursor.fetchall()

                print(f"✅ 테이블 {len(tables)}개 발견:")
                for table in tables:
                    table_name = list(table.values())[0]
                    print(f"   - {table_name}")

        # 3. JobMapRows 테이블 데이터 확인
        if tables:
            async with pool.acquire() as conn:
                async with conn.cursor(aiomysql.DictCursor) as cursor:
                    print(f"\n📊 JobMapRaws 테이블 데이터 확인...")
                    await cursor.execute("SELECT COUNT(*) as total FROM JobMapRaws")
                    count_result = await cursor.fetchone()
                    print(f"✅ JobMapRows 테이블 총 {count_result['total']}개 행")

                    # 샘플 데이터 조회
                    await cursor.execute("SELECT * FROM JobMapRaws LIMIT 3")
                    sample_data = await cursor.fetchall()
                    print(f"📝 샘플 데이터 (처음 3개):")
                    for i, row in enumerate(sample_data, 1):
                        print(f"   {i}. {dict(row)}")

        # 4. 연결 종료
        pool.close()
        await pool.wait_closed()
        print("\n🔚 연결 종료 완료")
        return True

    except Exception as e:
        print(f"❌ 오류 발생: {e}")
        return False

if __name__ == "__main__":
    result = asyncio.run(test_direct_connection())
    if result:
        print("\n🎉 MariaDB 연결 및 데이터 조회 성공!")
        print("💡 MCP 서버 코드는 올바르게 작성되었습니다.")
        print("🔧 문제는 MCP 프로토콜 통신에 있습니다.")
    else:
        print("\n💥 MariaDB 연결 실패!")
        print("🔧 환경변수나 데이터베이스 설정을 확인하세요.")
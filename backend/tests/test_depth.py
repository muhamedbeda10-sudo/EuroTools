import pytest

from app.data.depth import build, parse_side


def levels(text, near=0.827):
    return [(lv["price"], lv["size"], lv["orders"]) for lv in parse_side(text, near)]


@pytest.mark.parametrize("text", [
    "0.827,107879,4|0.825,45000,2|0.824,5971,1",                       # price,size,orders
    "4;107879;0.827\n2;45000;0.825\n1;5971;0.824",                     # orders;size;price, one per line
    "107879@0.827(4)#45000@0.825(2)#5971@0.824(1)",
    '[{"Price":0.827,"Volume":107879,"OrdersCount":4},{"Price":0.825,"Volume":45000,"OrdersCount":2},'
    '{"Price":0.824,"Volume":5971,"OrdersCount":1}]',
    '{"levels":[[0.827,107879,4],[0.825,45000,2],[0.824,5971,1]]}',
    "0.827 107879 4 0.825 45000 2 0.824 5971 1",                        # one flat run, in threes
])
def test_the_same_book_is_read_from_many_layouts(text):
    assert levels(text) == [(0.827, 107879.0, 4), (0.825, 45000.0, 2), (0.824, 5971.0, 1)]


def test_levels_without_an_order_count_and_unreadable_text():
    assert levels("0.827,107879|0.825,45000") == [(0.827, 107879.0, None), (0.825, 45000.0, None)]
    assert parse_side("", 1) == [] and parse_side(None, 1) == [] and parse_side("n/a", 1) == []
    # a size that happens to be small is still not taken for the price
    assert levels("0.83,1,1|0.84,2,1", near=0.83) == [(0.83, 1.0, 1), (0.84, 2.0, 1)]
    # numbers nowhere near the last price are not a price level
    assert parse_side("900,5000|950,100", near=0.827) == []


def test_build_orders_the_book_and_computes_the_summary():
    row = {"m_LastTradePrice": "0.827", "m_BidPrice": "0.827", "m_AskPrice": "0.828",
           "m_BidBook": "0.825,45000,2|0.827,107879,4", "m_AskBook": "0.829,401808,3|0.828,155401,1",
           "m_TotalBids": "19225841", "m_TotalAsks": "18831655"}
    b = build(row)
    assert [lv["price"] for lv in b["bids"]] == [0.827, 0.825] and [lv["price"] for lv in b["asks"]] == [0.828, 0.829]
    assert b["best_bid_size"] == 107879 and b["best_ask_size"] == 155401
    assert b["spread"] == pytest.approx(0.001) and b["spread_pct"] == pytest.approx(0.1209, abs=1e-3)
    assert b["bid_share_pct"] == pytest.approx(50.52, abs=0.01) and b["unread"] is None


def test_build_falls_back_to_the_top_of_book_and_reports_what_it_could_not_read():
    b = build({"m_LastTradePrice": "10", "m_BidPrice": "9.9", "m_BidVol": "500", "m_AskPrice": "10.1", "m_AskVol": "700",
               "m_BidBook": "<<opaque blob>>", "m_AskBook": ""})
    assert b["bids"] == [{"price": 9.9, "size": 500.0, "orders": None}] and b["asks"][0]["size"] == 700
    assert b["unread"] == {"bids": "<<opaque blob>>"}
    empty = build({})
    assert empty["bids"] == [] and empty["best_bid"] is None and empty["spread"] is None and empty["bid_share_pct"] is None

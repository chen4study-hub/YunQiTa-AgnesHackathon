import numpy as np
import pandas as pd
import pytest
from scripts.research_recency import recency_weights


def test_recency_weights_use_training_end_and_half_life():
    t=pd.Series(pd.to_datetime(['2017-01-01','2017-02-26'],utc=True))
    np.testing.assert_allclose(recency_weights(t,8),[.5,1.])
    with pytest.raises(ValueError):recency_weights(t,0)
